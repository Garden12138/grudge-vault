import AppKit
import Foundation

let buildDirectory = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? "apps/desktop/build", isDirectory: true)
let iconsetDirectory = buildDirectory.appendingPathComponent("icon.iconset", isDirectory: true)
try FileManager.default.createDirectory(at: iconsetDirectory, withIntermediateDirectories: true)

func renderIcon(size: Int) throws -> Data {
    guard let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    ), let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
        throw NSError(domain: "GrudgeVaultIcon", code: 1)
    }

    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    context.imageInterpolation = .high
    let scale = CGFloat(size) / 1024

    NSColor.clear.setFill()
    NSBezierPath(rect: NSRect(x: 0, y: 0, width: size, height: size)).fill()
    let background = NSBezierPath(roundedRect: NSRect(
        x: 58 * scale, y: 58 * scale, width: 908 * scale, height: 908 * scale
    ), xRadius: 205 * scale, yRadius: 205 * scale)
    NSColor(calibratedRed: 36.0 / 255.0, green: 92.0 / 255.0, blue: 228.0 / 255.0, alpha: 1).setFill()
    background.fill()

    // The same book mark used in the redesign prototype, enlarged for the Dock.
    let transform = NSAffineTransform()
    transform.translateX(by: CGFloat(size) * 0.16, yBy: CGFloat(size) * 0.84)
    transform.scaleX(by: CGFloat(size) * 0.0283, yBy: -CGFloat(size) * 0.0283)
    transform.concat()
    let book = NSBezierPath()
    book.move(to: NSPoint(x: 6, y: 3))
    book.line(to: NSPoint(x: 18, y: 3))
    book.line(to: NSPoint(x: 18, y: 21))
    book.line(to: NSPoint(x: 6, y: 21))
    book.curve(to: NSPoint(x: 6, y: 15), controlPoint1: NSPoint(x: 2, y: 21), controlPoint2: NSPoint(x: 2, y: 15))
    book.line(to: NSPoint(x: 18, y: 15))
    book.move(to: NSPoint(x: 6, y: 3))
    book.curve(to: NSPoint(x: 3, y: 6), controlPoint1: NSPoint(x: 4, y: 3), controlPoint2: NSPoint(x: 3, y: 4))
    book.line(to: NSPoint(x: 3, y: 18))
    book.move(to: NSPoint(x: 8, y: 7))
    book.line(to: NSPoint(x: 14, y: 7))
    book.move(to: NSPoint(x: 8, y: 10))
    book.line(to: NSPoint(x: 12, y: 10))
    book.lineWidth = 1.7
    book.lineCapStyle = .round
    book.lineJoinStyle = .round
    NSColor.white.setStroke()
    book.stroke()

    context.flushGraphics()
    NSGraphicsContext.restoreGraphicsState()
    guard let png = bitmap.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "GrudgeVaultIcon", code: 2)
    }
    return png
}

let variants: [(String, Int)] = [
    ("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024)
]
for (fileName, size) in variants {
    try renderIcon(size: size).write(to: iconsetDirectory.appendingPathComponent(fileName), options: .atomic)
}

let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["-c", "icns", "-o", buildDirectory.appendingPathComponent("icon.icns").path, iconsetDirectory.path]
try iconutil.run()
iconutil.waitUntilExit()
guard iconutil.terminationStatus == 0 else {
    throw NSError(domain: "GrudgeVaultIcon", code: 3)
}
