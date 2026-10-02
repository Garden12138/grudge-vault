// Local fictional text fixtures only; never linked into the packaged application.
import Foundation
import CoreGraphics
import CoreText
import ImageIO
import UniformTypeIdentifiers
@preconcurrency import AVFoundation
import CoreVideo

enum KitFailure: Error { case invalid, generation }
func localAsset(_ url: URL) -> AVURLAsset {
    AVURLAsset(url: url, options: [AVURLAssetReferenceRestrictionsKey: AVAssetReferenceRestrictions.forbidAll.rawValue])
}
func little<T: FixedWidthInteger>(_ value: T) -> Data {
    var encoded = value.littleEndian
    return withUnsafeBytes(of: &encoded) { Data($0) }
}
func checkAudio(_ input: URL, _ output: URL) async throws {
    let asset = localAsset(input)
    guard let track = try await asset.loadTracks(withMediaType: .audio).first,
          !FileManager.default.fileExists(atPath: output.path) else { throw KitFailure.invalid }
    let reader = try AVAssetReader(asset: asset)
    let samples = AVAssetReaderTrackOutput(track: track, outputSettings: [AVFormatIDKey: kAudioFormatLinearPCM,
        AVSampleRateKey: 16000, AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16,
        AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false])
    guard reader.canAdd(samples) else { throw KitFailure.generation }
    reader.add(samples); guard reader.startReading() else { throw KitFailure.generation }
    var pcm = Data()
    while let sample = samples.copyNextSampleBuffer() {
        guard let block = CMSampleBufferGetDataBuffer(sample), let description = CMSampleBufferGetFormatDescription(sample),
              let format = CMAudioFormatDescriptionGetStreamBasicDescription(description),
              format.pointee.mFormatID == kAudioFormatLinearPCM, format.pointee.mBitsPerChannel == 16,
              format.pointee.mSampleRate == 16000, format.pointee.mChannelsPerFrame == 1 else { throw KitFailure.generation }
        let length = CMBlockBufferGetDataLength(block)
        guard length > 0, length % 2 == 0, length <= 1_000_000, pcm.count + length <= 1_000_000 else { throw KitFailure.generation }
        var bytes = Data(count: length)
        let copied = bytes.withUnsafeMutableBytes { raw in
            CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: raw.baseAddress!)
        }
        guard copied == kCMBlockBufferNoErr else { throw KitFailure.generation }; pcm.append(bytes)
    }
    guard reader.status == .completed else { throw KitFailure.generation }
    var wav = Data("RIFF".utf8); wav.append(little(UInt32(pcm.count + 36))); wav.append(Data("WAVEfmt ".utf8))
    wav.append(little(UInt32(16))); wav.append(little(UInt16(1))); wav.append(little(UInt16(1)))
    wav.append(little(UInt32(16000))); wav.append(little(UInt32(32000))); wav.append(little(UInt16(2))); wav.append(little(UInt16(16)))
    wav.append(Data("data".utf8)); wav.append(little(UInt32(pcm.count))); wav.append(pcm)
    try wav.write(to: output, options: .atomic)
}
func drawCard(_ text: String, _ output: URL) throws {
    let width = 800, height = 600
    guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw KitFailure.generation }
    context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    let attributes: [NSAttributedString.Key: Any] = [
        NSAttributedString.Key(kCTFontAttributeName as String): CTFontCreateWithName("PingFangSC-Regular" as CFString, 40, nil),
        NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(red: 0.08, green: 0.12, blue: 0.18, alpha: 1)
    ]
    let value = NSAttributedString(string: text, attributes: attributes)
    let setter = CTFramesetterCreateWithAttributedString(value)
    let path = CGPath(rect: CGRect(x: 40, y: 40, width: width - 80, height: height - 80), transform: nil)
    let frame = CTFramesetterCreateFrame(setter, CFRange(location: 0, length: value.length), path, nil)
    guard CTFrameGetVisibleStringRange(frame).length == value.length else { throw KitFailure.generation }
    CTFrameDraw(frame, context)
    guard let image = context.makeImage(), let destination = CGImageDestinationCreateWithURL(output as CFURL, UTType.png.identifier as CFString, 1, nil) else { throw KitFailure.generation }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { throw KitFailure.generation }
}

func makeVideo(_ png: URL, _ audio: URL, _ output: URL) async throws {
    guard let imageSource = CGImageSourceCreateWithURL(png as CFURL, nil), let image = CGImageSourceCreateImageAtIndex(imageSource, 0, nil) else { throw KitFailure.invalid }
    let source = localAsset(audio)
    let duration = try await source.load(.duration)
    guard duration.seconds.isFinite, duration.seconds >= 0.5, duration.seconds <= 30,
          let audioTrack = try await source.loadTracks(withMediaType: .audio).first else { throw KitFailure.invalid }
    let rawVideo = output.deletingLastPathComponent().appendingPathComponent(UUID().uuidString + ".mov")
    defer { try? FileManager.default.removeItem(at: rawVideo) }
    let writer = try AVAssetWriter(outputURL: rawVideo, fileType: .mov)
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: image.width, AVVideoHeightKey: image.height])
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: image.width, kCVPixelBufferHeightKey as String: image.height])
    guard writer.canAdd(input) else { throw KitFailure.generation }
    writer.add(input); guard writer.startWriting() else { throw KitFailure.generation }; writer.startSession(atSourceTime: .zero)
    let frameCount = Int(ceil(duration.seconds * 5))
    for index in 0..<frameCount {
        while !input.isReadyForMoreMediaData {
            guard writer.status == .writing else { throw KitFailure.generation }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        var pixel: CVPixelBuffer?
        guard CVPixelBufferCreate(kCFAllocatorDefault, image.width, image.height, kCVPixelFormatType_32BGRA, nil, &pixel) == kCVReturnSuccess,
              let pixel = pixel else { throw KitFailure.generation }
        CVPixelBufferLockBaseAddress(pixel, [])
        guard let context = CGContext(data: CVPixelBufferGetBaseAddress(pixel), width: image.width, height: image.height,
            bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(pixel), space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue) else { throw KitFailure.generation }
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        CVPixelBufferUnlockBaseAddress(pixel, [])
        guard adaptor.append(pixel, withPresentationTime: CMTime(value: Int64(index), timescale: 5)) else { throw KitFailure.generation }
    }
    writer.endSession(atSourceTime: CMTime(value: Int64(frameCount), timescale: 5)); input.markAsFinished()
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in writer.finishWriting { continuation.resume() } }
    guard writer.status == .completed else { throw KitFailure.generation }
    let composition = AVMutableComposition()
    let visual = localAsset(rawVideo)
    guard let sourceVideo = try await visual.loadTracks(withMediaType: .video).first,
          let picture = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid),
          let speech = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else { throw KitFailure.generation }
    // Both tracks cover the complete spoken source; no fixed four-second truncation.
    try picture.insertTimeRange(CMTimeRange(start: .zero, duration: duration), of: sourceVideo, at: .zero)
    try speech.insertTimeRange(CMTimeRange(start: .zero, duration: duration), of: audioTrack, at: .zero)
    guard let export = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetMediumQuality),
          export.supportedFileTypes.contains(.mp4) else { throw KitFailure.generation }
    export.outputURL = output; export.outputFileType = .mp4
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in export.exportAsynchronously { continuation.resume() } }
    guard export.status == .completed else { throw KitFailure.generation }
}

@main struct ScreeningKit {
    static func main() async {
        do {
            let args = CommandLine.arguments
            guard args.count >= 4, args.dropFirst(2).allSatisfy({ $0.hasPrefix("/") }) else { throw KitFailure.invalid }
            if args[1] == "image", args.count == 4 {
                let text = try String(contentsOfFile: args[2], encoding: .utf8)
                guard !text.isEmpty, text.utf16.count <= 400 else { throw KitFailure.invalid }
                try drawCard(text, URL(fileURLWithPath: args[3]))
            } else if args[1] == "video", args.count == 5 {
                try await makeVideo(URL(fileURLWithPath: args[2]), URL(fileURLWithPath: args[3]), URL(fileURLWithPath: args[4]))
            } else if args[1] == "audio-check", args.count == 4 {
                try await checkAudio(URL(fileURLWithPath: args[2]), URL(fileURLWithPath: args[3]))
            } else { throw KitFailure.invalid }
        } catch { FileHandle.standardError.write(Data("SCREENING_KIT_NATIVE_FAILED\n".utf8)); exit(1) }
    }
}
