import Foundation
import ImageIO
import CoreGraphics
import UniformTypeIdentifiers

// Inspect data references before invoking Image I/O. A private image may not
// instruct the decoder to fetch another local file or a remote resource.
func validateHEIF(_ data: Data) throws {
    guard data.count >= 16, data.count <= 20 * 1024 * 1024 else { throw MediaFailure.unavailable }
    var remainingBoxes = 50_000
    var remainingExtents = 50_000
    var sawLocations = false
    func number(_ offset: Int, _ size: Int, _ end: Int) throws -> UInt64 {
        guard size >= 0, size <= 8, offset >= 0, offset <= end, size <= end - offset else { throw MediaFailure.unavailable }
        return data[offset..<(offset + size)].reduce(0) { ($0 << 8) | UInt64($1) }
    }
    struct Box { let kind: String; let payload: Int; let end: Int }
    func box(_ offset: Int, _ end: Int) throws -> Box {
        remainingBoxes -= 1
        guard remainingBoxes >= 0, offset <= end, end - offset >= 8,
              let kind = String(data: data[(offset + 4)..<(offset + 8)], encoding: .ascii) else { throw MediaFailure.unavailable }
        var size = try number(offset, 4, end)
        var header = 8
        if size == 1 { size = try number(offset + 8, 8, end); header = 16 }
        if size == 0 { size = UInt64(end - offset) }
        guard size >= UInt64(header), size <= UInt64(end - offset) else { throw MediaFailure.unavailable }
        return Box(kind: kind, payload: offset + header, end: offset + Int(size))
    }
    let first = try box(0, data.count)
    guard first.kind == "ftyp", first.end - first.payload >= 8,
          (first.end - first.payload) % 4 == 0 else { throw MediaFailure.unavailable }
    var brands: [String] = []
    for offset in stride(from: first.payload, to: first.end, by: 4) where offset != first.payload + 4 {
        brands.append(String(data: data[offset..<(offset + 4)], encoding: .ascii) ?? "")
    }
    guard brands.contains(where: { ["heic", "heix", "hevc", "hevx"].contains($0) }) else { throw MediaFailure.unavailable }
    func locations(_ current: Box) throws {
        var position = current.payload
        func take(_ count: Int) throws -> UInt64 {
            let value = try number(position, count, current.end); position += count; return value
        }
        let full = try take(4)
        let version = full >> 24
        guard version <= 2, full & 0x00ffffff == 0 else { throw MediaFailure.unavailable }
        let sizes = try take(2)
        let offsetSize = Int((sizes >> 12) & 15), lengthSize = Int((sizes >> 8) & 15)
        let baseSize = Int((sizes >> 4) & 15), indexSize = Int(sizes & 15)
        guard [offsetSize, lengthSize, baseSize, indexSize].allSatisfy({ [0, 4, 8].contains($0) }),
              version != 0 || indexSize == 0 else { throw MediaFailure.unavailable }
        let count = try take(version == 2 ? 4 : 2)
        guard count > 0, count <= 10_000 else { throw MediaFailure.unavailable }
        for _ in 0..<count {
            _ = try take(version == 2 ? 4 : 2)
            let construction = version == 0 ? 0 : try take(2)
            guard construction <= 2, try take(2) == 0 else { throw MediaFailure.unavailable }
            let base = try take(baseSize)
            let extents = try take(2)
            guard base <= UInt64(data.count), extents > 0, extents <= UInt64(remainingExtents) else { throw MediaFailure.unavailable }
            remainingExtents -= Int(extents)
            for _ in 0..<extents {
                if version > 0 { _ = try take(indexSize) }
                let offset = try take(offsetSize), length = try take(lengthSize)
                guard offset <= UInt64(data.count), length <= UInt64(data.count) else { throw MediaFailure.unavailable }
                if construction == 0 {
                    guard offset <= UInt64(data.count) - base,
                          length <= UInt64(data.count) - base - offset else { throw MediaFailure.unavailable }
                }
            }
        }
        guard position == current.end else { throw MediaFailure.unavailable }
        sawLocations = true
    }
    func walk(_ from: Int, _ end: Int, _ depth: Int) throws {
        guard depth <= 8 else { throw MediaFailure.unavailable }
        var offset = from
        while offset < end {
            let current = try box(offset, end)
            guard !["moov", "trak", "cmov", "rmra", "rmda", "rdrf", "auxC", "auxl"].contains(current.kind) else { throw MediaFailure.unavailable }
            if current.kind == "iloc" { try locations(current) }
            if current.kind == "meta" {
                guard try number(current.payload, 4, current.end) == 0 else { throw MediaFailure.unavailable }
                try walk(current.payload + 4, current.end, depth + 1)
            } else if ["dinf", "iprp", "ipco"].contains(current.kind) {
                try walk(current.payload, current.end, depth + 1)
            } else if current.kind == "iref" {
                guard try number(current.payload, 4, current.end) <= 0x01000000 else { throw MediaFailure.unavailable }
                try walk(current.payload + 4, current.end, depth + 1)
            } else if current.kind == "colr", current.end - current.payload >= 4,
                String(data: data[current.payload..<(current.payload + 4)], encoding: .ascii) == "nclx" {
                let transfer = try number(current.payload + 6, 2, current.end)
                guard transfer != 16, transfer != 18 else { throw MediaFailure.unavailable }
            } else if current.kind == "dref" {
                guard try number(current.payload, 4, current.end) == 0 else { throw MediaFailure.unavailable }
                let count = try number(current.payload + 4, 4, current.end)
                guard count <= 64 else { throw MediaFailure.unavailable }
                var entry = current.payload + 8
                for _ in 0..<count {
                    let reference = try box(entry, current.end)
                    guard ["url ", "alis"].contains(reference.kind), reference.end - reference.payload == 4,
                          try number(reference.payload, 4, reference.end) == 1 else { throw MediaFailure.unavailable }
                    entry = reference.end
                }
                guard entry == current.end else { throw MediaFailure.unavailable }
            } else if current.kind == "iinf" {
                let version = try number(current.payload, 1, current.end)
                guard version <= 1 else { throw MediaFailure.unavailable }
                try walk(current.payload + 4 + (version == 0 ? 2 : 4), current.end, depth + 1)
            } else if current.kind == "infe" {
                let version = try number(current.payload, 1, current.end)
                guard version == 2 || version == 3 else { throw MediaFailure.unavailable }
                let typeOffset = current.payload + 4 + (version == 2 ? 2 : 4) + 2
                guard current.end - typeOffset >= 4,
                      !["uri ", "tmap"].contains(String(data: data[typeOffset..<(typeOffset + 4)], encoding: .ascii) ?? "") else { throw MediaFailure.unavailable }
            }
            offset = current.end
        }
    }
    try walk(0, data.count, 0)
    guard sawLocations else { throw MediaFailure.unavailable }
}

private final class BoundedImageSink {
    let file: FileHandle
    let limit: Int
    let lock = NSLock()
    var written = 0
    var tooLarge = false
    var failed = false
    init(_ file: FileHandle, _ limit: Int) { self.file = file; self.limit = limit }
    func put(_ buffer: UnsafeRawPointer, _ count: Int) -> Int {
        lock.lock(); defer { lock.unlock() }
        guard count >= 0, count <= limit - written, !failed, !tooLarge else { tooLarge = true; return 0 }
        do { try file.write(contentsOf: Data(bytes: buffer, count: count)); written += count; return count }
        catch { failed = true; return 0 }
    }
}

private func writeImage(_ image: CGImage, _ output: URL, _ type: String, _ limit: Int) throws {
    guard !FileManager.default.fileExists(atPath: output.path),
          FileManager.default.createFile(atPath: output.path, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw MediaFailure.processing }
    let file = try FileHandle(forWritingTo: output)
    defer { try? file.close() }
    let sink = BoundedImageSink(file, limit)
    var callbacks = CGDataConsumerCallbacks(putBytes: { info, buffer, count in
        guard let info else { return 0 }
        return Unmanaged<BoundedImageSink>.fromOpaque(info).takeUnretainedValue().put(buffer, count)
    }, releaseConsumer: nil)
    guard let consumer = CGDataConsumer(info: Unmanaged.passUnretained(sink).toOpaque(), cbks: &callbacks),
          let destination = CGImageDestinationCreateWithDataConsumer(consumer, type as CFString, 1, nil) else { throw MediaFailure.processing }
    // New raster only: no source EXIF, GPS, identifiers, thumbnails or maker notes.
    let properties: [CFString: Any] = type == UTType.jpeg.identifier ? [kCGImageDestinationLossyCompressionQuality: 0.95] : [:]
    CGImageDestinationAddImage(destination, image, properties as CFDictionary)
    let completed = CGImageDestinationFinalize(destination)
    if sink.tooLarge { throw MediaFailure.tooLarge }
    guard completed, !sink.failed, sink.written > 0 else { throw MediaFailure.processing }
}

func convertHEIF(_ input: URL, _ output: URL, _ limit: Int) throws -> [String: Any] {
    guard limit >= 1024, limit <= 7_000_000 else { throw MediaFailure.invalidInput }
    let attributes = try FileManager.default.attributesOfItem(atPath: input.path)
    guard let size = attributes[.size] as? NSNumber, size.intValue > 0, size.intValue <= 20 * 1024 * 1024 else { throw MediaFailure.unavailable }
    let data = try Data(contentsOf: input)
    try validateHEIF(data)
    guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
          ["public.heic", "public.heif"].contains(CGImageSourceGetType(source) as String? ?? ""),
          CGImageSourceGetCount(source) == 1,
          let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let width = properties[kCGImagePropertyPixelWidth] as? Int,
          let height = properties[kCGImagePropertyPixelHeight] as? Int,
          width > 0, height > 0, width <= 50_000, height <= 50_000, width <= 50_000_000 / height,
          let depth = properties[kCGImagePropertyDepth] as? Int, depth > 0, depth <= 8 else { throw MediaFailure.unavailable }
    if CGImageSourceCopyAuxiliaryDataInfoAtIndex(source, 0, kCGImageAuxiliaryDataTypeHDRGainMap) != nil {
        throw MediaFailure.unavailable
    }
    if #available(macOS 15.0, *), CGImageSourceCopyAuxiliaryDataInfoAtIndex(source, 0, kCGImageAuxiliaryDataTypeISOGainMap) != nil {
        throw MediaFailure.unavailable
    }
    let orientation = properties[kCGImagePropertyOrientation] as? Int ?? 1
    guard (1...8).contains(orientation) else { throw MediaFailure.unavailable }
    let expectedWidth = orientation >= 5 ? height : width
    let expectedHeight = orientation >= 5 ? width : height
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: max(width, height),
        kCGImageSourceShouldAllowFloat: false,
        kCGImageSourceShouldCacheImmediately: true
    ] as CFDictionary), image.width == expectedWidth, image.height == expectedHeight,
       image.bitsPerComponent <= 8 else { throw MediaFailure.unavailable }
    if let space = image.colorSpace {
        guard !space.isHDR(), !CGColorSpaceUsesExtendedRange(space) else { throw MediaFailure.unavailable }
    }
    // A fresh raster severs any Image I/O source metadata association. Retain
    // the decoded colour space, but do not pass source properties to an encoder.
    guard let context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8,
        bytesPerRow: image.width * 4, space: image.colorSpace?.model == .rgb ? image.colorSpace! : CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw MediaFailure.processing }
    context.interpolationQuality = .none
    context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    guard let rasterCopy = context.makeImage() else { throw MediaFailure.processing }
    var format = "png"
    do { try writeImage(rasterCopy, output, UTType.png.identifier, limit) }
    catch MediaFailure.tooLarge {
        // Keep every pixel. Do not reduce resolution or keep lowering quality to fit.
        guard properties[kCGImagePropertyHasAlpha] as? Bool != true else { throw MediaFailure.unavailable }
        try FileManager.default.removeItem(at: output)
        try writeImage(rasterCopy, output, UTType.jpeg.identifier, limit)
        format = "jpeg"
    }
    guard let checked = CGImageSourceCreateWithURL(output as CFURL, nil),
          let raster = CGImageSourceCreateImageAtIndex(checked, 0, nil),
          raster.width == expectedWidth, raster.height == expectedHeight else { throw MediaFailure.processing }
    return ["ok": true, "format": format, "width": expectedWidth, "height": expectedHeight]
}
