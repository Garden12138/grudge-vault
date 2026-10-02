import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

enum FixtureError: Error { case invalid }

@main struct ImageFixture {
    static func main() throws {
        let args = CommandLine.arguments
        guard args.count >= 3 else { throw FixtureError.invalid }
        let path = URL(fileURLWithPath: args[2])
        if args[1] == "inspect" {
            guard let source = CGImageSourceCreateWithURL(path as CFURL, nil),
                  let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
                  let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
                  let context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8,
                    bytesPerRow: image.width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue), let raw = context.data else { throw FixtureError.invalid }
            context.interpolationQuality = .none
            context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
            let pixels = raw.assumingMemoryBound(to: UInt8.self)
            let points = [(image.width / 4, image.height / 4), (image.width * 3 / 4, image.height / 4),
                          (image.width / 4, image.height * 3 / 4), (image.width * 3 / 4, image.height * 3 / 4)]
            let colors = points.map { x, y in Array(UnsafeBufferPointer(start: pixels + (y * image.width + x) * 4, count: 3)).map(Int.init) }
            let exif = properties[kCGImagePropertyExifDictionary] as? [CFString: Any] ?? [:]
            let value: [String: Any] = ["width": image.width, "height": image.height,
                "orientation": properties[kCGImagePropertyOrientation] as? Int ?? 1,
                "count": CGImageSourceGetCount(source), "colors": colors,
                "hasGPS": properties[kCGImagePropertyGPSDictionary] != nil,
                "hasExif": properties[kCGImagePropertyExifDictionary] != nil,
                "exifKeys": exif.keys.map { $0 as String }.sorted(),
                "hasPrivateComment": exif[kCGImagePropertyExifUserComment] != nil,
                "format": CGImageSourceGetType(source) as String? ?? ""]
            FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]))
            return
        }
        guard args[1] == "generate", args.count == 6, let orientation = Int(args[3]), let count = Int(args[5]),
              (1...8).contains(orientation), (1...2).contains(count) else { throw FixtureError.invalid }
        let width = 96, height = 64
        var bytes = Data(count: width * height * 4)
        var noise: UInt32 = 0x12345678
        for y in 0..<height { for x in 0..<width {
            let palette: [[UInt8]] = [[230, 20, 20], [20, 220, 20], [20, 20, 230], [230, 220, 20]]
            let color: [UInt8]
            if args[4] == "noise" {
                noise = noise &* 1664525 &+ 1013904223
                color = [UInt8((noise >> 16) & 255), UInt8((noise >> 8) & 255), UInt8(noise & 255)]
            } else { color = palette[(y < height / 2 ? 0 : 2) + (x < width / 2 ? 0 : 1)] }
            let offset = (y * width + x) * 4
            bytes[offset] = color[0]; bytes[offset + 1] = color[1]; bytes[offset + 2] = color[2]; bytes[offset + 3] = 255
        } }
        guard let provider = CGDataProvider(data: bytes as CFData),
              let image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4,
                space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
                provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent),
              let destination = CGImageDestinationCreateWithURL(path as CFURL, UTType.heic.identifier as CFString, count, nil) else { throw FixtureError.invalid }
        for _ in 0..<count {
            CGImageDestinationAddImage(destination, image, [
                kCGImagePropertyOrientation: orientation, kCGImageDestinationLossyCompressionQuality: 1.0,
                kCGImagePropertyGPSDictionary: [kCGImagePropertyGPSLatitude: 31.21, kCGImagePropertyGPSLatitudeRef: "N",
                    kCGImagePropertyGPSLongitude: 121.47, kCGImagePropertyGPSLongitudeRef: "E"],
                kCGImagePropertyExifDictionary: [kCGImagePropertyExifUserComment: "GV_SYNTHETIC_PRIVATE_IMAGE_METADATA"]
            ] as CFDictionary)
        }
        guard CGImageDestinationFinalize(destination) else { throw FixtureError.invalid }
    }
}
