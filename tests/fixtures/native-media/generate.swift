// Synthetic test fixtures only. Never used by the packaged application.
import Foundation
@preconcurrency import AVFoundation
import CoreVideo

enum FixtureFailure: Error { case invalidInput, generation }

func video(at output: URL) async throws {
    let writer = try AVAssetWriter(outputURL: output, fileType: .mov)
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 96, AVVideoHeightKey: 64,
        AVVideoCompressionPropertiesKey: [AVVideoMaxKeyFrameIntervalKey: 20, AVVideoExpectedSourceFrameRateKey: 10]
    ])
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: 96, kCVPixelBufferHeightKey as String: 64
    ])
    guard writer.canAdd(input) else { throw FixtureFailure.generation }
    writer.add(input)
    guard writer.startWriting() else { throw FixtureFailure.generation }
    writer.startSession(atSourceTime: .zero)
    for frame in 0..<40 {
        while !input.isReadyForMoreMediaData {
            guard writer.status == .writing else { throw FixtureFailure.generation }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        var buffer: CVPixelBuffer?
        guard CVPixelBufferCreate(kCFAllocatorDefault, 96, 64, kCVPixelFormatType_32BGRA, nil, &buffer) == kCVReturnSuccess,
              let buffer = buffer else { throw FixtureFailure.generation }
        CVPixelBufferLockBaseAddress(buffer, [])
        guard let address = CVPixelBufferGetBaseAddress(buffer) else { throw FixtureFailure.generation }
        let stride = CVPixelBufferGetBytesPerRow(buffer)
        for row in 0..<64 {
            let pixels = address.advanced(by: row * stride).assumingMemoryBound(to: UInt32.self)
            for column in 0..<96 {
                pixels[column] = 0xff000000 | UInt32((column * 13 + frame * 17) % 256) |
                    (UInt32((row * 11 + frame * 7) % 256) << 8) | (UInt32(frame * 6) << 16)
            }
        }
        CVPixelBufferUnlockBaseAddress(buffer, [])
        guard adaptor.append(buffer, withPresentationTime: CMTime(value: Int64(frame), timescale: 10)) else { throw FixtureFailure.generation }
    }
    writer.endSession(atSourceTime: CMTime(value: 4, timescale: 1))
    input.markAsFinished()
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        writer.finishWriting { continuation.resume() }
    }
    guard writer.status == .completed else { throw FixtureFailure.generation }
}

@main struct FixtureGenerator {
    static func main() async {
        do {
            let args = CommandLine.arguments
            guard args.count == 4, args[1].hasPrefix("/"), args[2].hasPrefix("/"),
                  ["video", "video-mov", "multi-track", "gapped-audio", "reference-video"].contains(args[3]) else { throw FixtureFailure.invalidInput }
            let output = URL(fileURLWithPath: args[2])
            if args[3] == "reference-video" {
                let movie = AVMovie(url: URL(fileURLWithPath: args[1]), options: nil)
                try movie.writeHeader(to: output, fileType: .mov, options: .truncateDestinationToMovieHeaderOnly)
                // Prove that the fixture is a functional local-reference movie under the system default policy.
                let reference = AVURLAsset(url: output)
                guard let track = try await reference.loadTracks(withMediaType: .video).first else { throw FixtureFailure.generation }
                let reader = try AVAssetReader(asset: reference)
                let samples = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
                guard reader.canAdd(samples) else { throw FixtureFailure.generation }
                reader.add(samples)
                guard reader.startReading(), samples.copyNextSampleBuffer() != nil else { throw FixtureFailure.generation }
                reader.cancelReading()
                return
            }
            let audioAsset = AVURLAsset(url: URL(fileURLWithPath: args[1]))
            guard let sourceAudio = try await audioAsset.loadTracks(withMediaType: .audio).first else { throw FixtureFailure.generation }
            let composition = AVMutableComposition()
            let fourSeconds = CMTimeRange(start: .zero, duration: CMTime(value: 4, timescale: 1))
            guard let audio = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else { throw FixtureFailure.generation }
            if args[3] == "gapped-audio" {
                try audio.insertTimeRange(CMTimeRange(start: .zero, duration: CMTime(value: 1, timescale: 1)), of: sourceAudio, at: .zero)
                try audio.insertTimeRange(CMTimeRange(start: CMTime(value: 1, timescale: 1), duration: CMTime(value: 2, timescale: 1)),
                                          of: sourceAudio, at: CMTime(value: 2, timescale: 1))
            } else {
                try audio.insertTimeRange(fourSeconds, of: sourceAudio, at: .zero)
                if args[3] == "multi-track" {
                    guard let second = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else { throw FixtureFailure.generation }
                    try second.insertTimeRange(fourSeconds, of: sourceAudio, at: .zero)
                }
                let rawVideo = output.deletingLastPathComponent().appendingPathComponent(UUID().uuidString + ".mov")
                defer { try? FileManager.default.removeItem(at: rawVideo) }
                try await video(at: rawVideo)
                let videoAsset = AVURLAsset(url: rawVideo)
                guard let sourceVideo = try await videoAsset.loadTracks(withMediaType: .video).first,
                      let track = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else { throw FixtureFailure.generation }
                try track.insertTimeRange(fourSeconds, of: sourceVideo, at: .zero)
                // Export before the raw video is removed by the scope's defer.
                try await export(composition, output: output, type: args[3] == "video-mov" ? .mov : .mp4)
                return
            }
            try await export(composition, output: output, type: .mp4)
        } catch { FileHandle.standardError.write(Data("Synthetic fixture generation failed.\n".utf8)); exit(1) }
    }

    static func export(_ asset: AVAsset, output: URL, type: AVFileType) async throws {
        guard let session = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetPassthrough),
              session.supportedFileTypes.contains(type) else { throw FixtureFailure.generation }
        session.outputURL = output
        session.outputFileType = type
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            session.exportAsynchronously { continuation.resume() }
        }
        guard session.status == .completed else { throw FixtureFailure.generation }
    }
}
