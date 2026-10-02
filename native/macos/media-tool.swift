import Foundation
@preconcurrency import AVFoundation

enum MediaFailure: Error { case invalidInput, unavailable, tooLarge, processing }

func localAsset(_ url: URL) -> AVURLAsset {
    // A selected container must not cause the decoder to open referenced local files or remote URLs.
    AVURLAsset(url: url, options: [
        AVURLAssetReferenceRestrictionsKey: AVAssetReferenceRestrictions.forbidAll.rawValue,
        AVURLAssetPreferPreciseDurationAndTimingKey: true
    ])
}

// Do not rely on decoder option flags alone: reference movies can still resolve local alias/bookmark data.
// Walk container headers only, never media payloads, and accept only explicit self-contained data references.
func validateSelfContained(_ url: URL) throws {
    let file = try FileHandle(forReadingFrom: url)
    defer { try? file.close() }
    let length = try file.seekToEnd()
    guard length >= 8, length <= 500 * 1024 * 1024 else { throw MediaFailure.unavailable }
    func read(_ offset: UInt64, _ count: Int) throws -> Data {
        guard count >= 0, count <= 4096, offset <= length, UInt64(count) <= length - offset else { throw MediaFailure.unavailable }
        try file.seek(toOffset: offset)
        guard let data = try file.read(upToCount: count), data.count == count else { throw MediaFailure.processing }
        return data
    }
    func number(_ bytes: Data) -> UInt64 { bytes.reduce(0) { ($0 << 8) | UInt64($1) } }
    let prefix = try read(0, Int(min(length, 12)))
    if length >= 12, String(data: prefix.prefix(4), encoding: .ascii) == "RIFF",
       String(data: prefix[8..<12], encoding: .ascii) == "WAVE" { return }
    if String(data: prefix.prefix(3), encoding: .ascii) == "ID3" ||
       prefix[0] == 0xff && prefix[1] & 0xe0 == 0xe0 { return }
    guard let firstType = String(data: prefix[4..<8], encoding: .ascii),
          ["ftyp", "moov", "mdat", "free", "skip", "wide", "moof", "rmra", "cmov"].contains(firstType) else { throw MediaFailure.unavailable }
    var remainingBoxes = 50_000
    var sawMovie = false
    var sawDataReference = false
    struct Box { let kind: String; let payload: UInt64; let end: UInt64 }
    func box(at offset: UInt64, end: UInt64) throws -> Box {
        remainingBoxes -= 1
        guard remainingBoxes >= 0, offset <= end, end - offset >= 8 else { throw MediaFailure.unavailable }
        let header = try read(offset, 8)
        guard let kind = String(data: header[4..<8], encoding: .ascii) else { throw MediaFailure.unavailable }
        var size = number(header.prefix(4))
        var headerSize: UInt64 = 8
        if size == 1 { size = number(try read(offset + 8, 8)); headerSize = 16 }
        if size == 0 { size = end - offset }
        guard size >= headerSize, size <= end - offset else { throw MediaFailure.unavailable }
        return Box(kind: kind, payload: offset + headerSize, end: offset + size)
    }
    func walk(from: UInt64, to: UInt64, depth: Int) throws {
        guard depth <= 8 else { throw MediaFailure.unavailable }
        var offset = from
        while offset < to {
            let current = try box(at: offset, end: to)
            // Compressed and legacy reference movie headers could hide references from this bounded walker.
            guard !["cmov", "rmra", "rmda", "rdrf"].contains(current.kind) else { throw MediaFailure.unavailable }
            if current.kind == "moov" { sawMovie = true }
            if current.kind == "dref" {
                guard current.end - current.payload >= 8 else { throw MediaFailure.unavailable }
                let header = try read(current.payload, 8)
                let count = number(header[4..<8])
                guard number(header.prefix(4)) == 0, count > 0, count <= 64 else { throw MediaFailure.unavailable }
                var entryOffset = current.payload + 8
                for _ in 0..<count {
                    let entry = try box(at: entryOffset, end: current.end)
                    guard ["url ", "alis"].contains(entry.kind), entry.end - entry.payload == 4,
                          number(try read(entry.payload, 4)) == 1 else { throw MediaFailure.unavailable }
                    entryOffset = entry.end
                    sawDataReference = true
                }
                guard entryOffset == current.end else { throw MediaFailure.unavailable }
            } else if ["moov", "trak", "mdia", "minf", "dinf"].contains(current.kind) {
                try walk(from: current.payload, to: current.end, depth: depth + 1)
            }
            offset = current.end
        }
    }
    try walk(from: 0, to: length, depth: 0)
    guard sawMovie, sawDataReference else { throw MediaFailure.unavailable }
}

func reply(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data)
    }
}

func durationMilliseconds(_ asset: AVAsset) async throws -> Int64 {
    let seconds = try await asset.load(.duration).seconds
    guard seconds.isFinite, seconds > 0, seconds < 32_000_000 else { throw MediaFailure.unavailable }
    return Int64(ceil(seconds * 1000))
}

func audioFormat(_ track: AVAssetTrack) async throws -> (rate: Double, channels: UInt32) {
    let formats = try await track.load(.formatDescriptions)
    guard let format = formats.first,
          let description = CMAudioFormatDescriptionGetStreamBasicDescription(format) else { throw MediaFailure.unavailable }
    let rate = description.pointee.mSampleRate
    let channels = description.pointee.mChannelsPerFrame
    // Preserve sample rate and both stereo channels; do not silently downmix spatial audio.
    guard rate.isFinite, rate >= 8000, rate <= 384000, rate.rounded() == rate,
          channels >= 1, channels <= 2 else { throw MediaFailure.unavailable }
    return (rate, channels)
}

func little<T: FixedWidthInteger>(_ value: T) -> Data {
    var encoded = value.littleEndian
    return withUnsafeBytes(of: &encoded) { Data($0) }
}

func wavHeader(bytes: Int, rate: Double, channels: UInt32) -> Data {
    let blockAlign = UInt16(channels * 2)
    var data = Data("RIFF".utf8)
    data.append(little(UInt32(bytes + 36))); data.append(Data("WAVEfmt ".utf8))
    data.append(little(UInt32(16))); data.append(little(UInt16(1))); data.append(little(UInt16(channels)))
    data.append(little(UInt32(rate))); data.append(little(UInt32(rate) * UInt32(blockAlign)))
    data.append(little(blockAlign)); data.append(little(UInt16(16)))
    data.append(Data("data".utf8)); data.append(little(UInt32(bytes)))
    return data
}

func exportAudio(_ asset: AVAsset, track: AVAssetTrack, output: URL, from: Int64, to: Int64, limit: Int) async throws {
    let format = try await audioFormat(track)
    let blockAlign = Int(format.channels * 2)
    // Round absolute boundaries on one sample grid; rounding each duration independently loses samples at joins.
    let firstSourceFrame = Int64((Double(from) * format.rate / 1000).rounded(.down))
    let lastSourceFrame = Int64((Double(to) * format.rate / 1000).rounded(.down))
    let frameLimit = Int(lastSourceFrame - firstSourceFrame)
    guard frameLimit > 0, frameLimit <= (limit - 44) / blockAlign else { throw MediaFailure.tooLarge }
    let reader = try AVAssetReader(asset: asset)
    reader.timeRange = CMTimeRange(start: CMTime(value: firstSourceFrame, timescale: CMTimeScale(format.rate)),
                                  duration: CMTime(value: lastSourceFrame - firstSourceFrame, timescale: CMTimeScale(format.rate)))
    let readerOutput = AVAssetReaderTrackOutput(track: track, outputSettings: [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVSampleRateKey: format.rate, AVNumberOfChannelsKey: format.channels,
        AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false,
        AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false
    ])
    readerOutput.alwaysCopiesSampleData = false
    guard reader.canAdd(readerOutput) else { throw MediaFailure.unavailable }
    reader.add(readerOutput)
    guard reader.startReading() else { throw MediaFailure.processing }
    defer { if reader.status == .reading { reader.cancelReading() } }
    guard !FileManager.default.fileExists(atPath: output.path),
          FileManager.default.createFile(atPath: output.path, contents: wavHeader(bytes: 0, rate: format.rate, channels: format.channels),
                                         attributes: [.posixPermissions: 0o600]) else { throw MediaFailure.processing }
    let file = try FileHandle(forWritingTo: output)
    defer { try? file.close() }
    try file.seekToEnd()
    var framesWritten = 0
    let silence = Data(repeating: 0, count: 64 * 1024 / blockAlign * blockAlign)
    func pad(until frame: Int) throws {
        while framesWritten < min(frame, frameLimit) {
            let frames = min(silence.count / blockAlign, min(frame, frameLimit) - framesWritten)
            try file.write(contentsOf: silence.prefix(frames * blockAlign))
            framesWritten += frames
        }
    }
    while let sample = readerOutput.copyNextSampleBuffer() {
        guard let block = CMSampleBufferGetDataBuffer(sample), let description = CMSampleBufferGetFormatDescription(sample),
              let decoded = CMAudioFormatDescriptionGetStreamBasicDescription(description),
              decoded.pointee.mFormatID == kAudioFormatLinearPCM, decoded.pointee.mBitsPerChannel == 16,
              decoded.pointee.mSampleRate == format.rate, decoded.pointee.mChannelsPerFrame == format.channels,
              decoded.pointee.mBytesPerFrame == UInt32(blockAlign) else { throw MediaFailure.processing }
        let length = CMBlockBufferGetDataLength(block)
        guard length >= 0, length <= 16 * 1024 * 1024, length % blockAlign == 0,
              CMSampleBufferGetNumSamples(sample) == length / blockAlign else { throw MediaFailure.processing }
        let position = CMSampleBufferGetPresentationTimeStamp(sample).seconds
        guard position.isFinite else { throw MediaFailure.processing }
        let firstFrame = Int((position * format.rate).rounded()) - Int(firstSourceFrame)
        try pad(until: firstFrame)
        let skip = max(0, framesWritten - firstFrame)
        let frames = max(0, min(length / blockAlign - skip, frameLimit - framesWritten))
        if frames > 0 {
            var data = Data(count: frames * blockAlign)
            let status = data.withUnsafeMutableBytes { raw in
                CMBlockBufferCopyDataBytes(block, atOffset: skip * blockAlign, dataLength: frames * blockAlign, destination: raw.baseAddress!)
            }
            guard status == kCMBlockBufferNoErr else { throw MediaFailure.processing }
            try file.write(contentsOf: data)
            framesWritten += frames
        }
    }
    guard reader.status == .completed else { throw MediaFailure.processing }
    // Presentation-time gaps remain silence instead of collapsing the original timeline.
    try pad(until: frameLimit)
    try file.seek(toOffset: 0)
    try file.write(contentsOf: wavHeader(bytes: framesWritten * blockAlign, rate: format.rate, channels: format.channels))
}

func exportVideo(_ asset: AVAsset, output: URL, from: Int64, to: Int64, limit: Int) async throws {
    guard let exporter = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetPassthrough),
          exporter.supportedFileTypes.contains(.mp4), !FileManager.default.fileExists(atPath: output.path) else { throw MediaFailure.unavailable }
    exporter.outputURL = output
    exporter.outputFileType = .mp4
    exporter.metadata = []
    exporter.timeRange = CMTimeRange(start: CMTime(value: from, timescale: 1000), duration: CMTime(value: to - from, timescale: 1000))
    exporter.shouldOptimizeForNetworkUse = false
    let monitor = Task {
        while !Task.isCancelled {
            if let attributes = try? FileManager.default.attributesOfItem(atPath: output.path),
               let size = attributes[.size] as? NSNumber, size.intValue > limit {
                exporter.cancelExport()
                return true
            }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        return false
    }
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        exporter.exportAsynchronously { continuation.resume() }
    }
    monitor.cancel()
    if await monitor.value { throw MediaFailure.tooLarge }
    guard exporter.status == .completed else { throw MediaFailure.processing }
    let attributes = try FileManager.default.attributesOfItem(atPath: output.path)
    guard let size = attributes[.size] as? NSNumber, size.intValue > 0, size.intValue <= limit else { throw MediaFailure.tooLarge }
}

@main struct MediaTool {
    static func main() async {
        do {
            let args = CommandLine.arguments
            guard args.count >= 3, args[2].hasPrefix("/") else { throw MediaFailure.invalidInput }
            let input = URL(fileURLWithPath: args[2])
            if args[1] == "image", args.count == 5, args[3].hasPrefix("/"), let limit = Int(args[4]) {
                reply(try convertHEIF(input, URL(fileURLWithPath: args[3]), limit))
                return
            }
            try validateSelfContained(input)
            let asset = localAsset(input)
            let audio = try await asset.loadTracks(withMediaType: .audio)
            let video = try await asset.loadTracks(withMediaType: .video)
            guard audio.count <= 1, video.count <= 1, !audio.isEmpty || !video.isEmpty else { throw MediaFailure.unavailable }
            let duration = try await durationMilliseconds(asset)
            if args[1] == "probe", args.count == 3 {
                var value: [String: Any] = ["ok": true, "durationMs": duration, "hasAudio": !audio.isEmpty, "hasVideo": !video.isEmpty]
                if video.isEmpty, let track = audio.first {
                    let format = try await audioFormat(track)
                    value["pcmBytesPerSecond"] = format.rate * Double(format.channels * 2)
                }
                reply(value)
            } else if args[1] == "segment", args.count == 8,
                      args[3].hasPrefix("/"), let from = Int64(args[5]), let to = Int64(args[6]), let limit = Int(args[7]),
                      from >= 0, to > from, to <= duration, limit >= 1024, limit <= 7_000_000 {
                let output = URL(fileURLWithPath: args[3])
                if args[4] == "audio", video.isEmpty, let track = audio.first {
                    try await exportAudio(asset, track: track, output: output, from: from, to: to, limit: limit)
                } else if args[4] == "video", !video.isEmpty {
                    try await exportVideo(asset, output: output, from: from, to: to, limit: limit)
                } else { throw MediaFailure.unavailable }
                try validateSelfContained(output)
                let result = localAsset(output)
                reply(["ok": true, "durationMs": try await durationMilliseconds(result)])
            } else { throw MediaFailure.invalidInput }
        } catch {
            let code: String
            switch error {
            case MediaFailure.tooLarge: code = "SEGMENT_TOO_LARGE"
            case MediaFailure.unavailable: code = "MODALITY_UNAVAILABLE"
            case MediaFailure.invalidInput: code = "INVALID_INPUT"
            default: code = "MEDIA_PROCESSING_FAILED"
            }
            // Never print framework NSError descriptions, filenames or input metadata.
            reply(["ok": false, "code": code])
            exit(1)
        }
    }
}
