import AppKit

private let designHeight: CGFloat = 460
private let logicalWidth: CGFloat = 2560
private let logicalHeight: CGFloat = 1600
private let scale: CGFloat = 2

guard CommandLine.arguments.count == 2 else {
  fputs("Usage: DmgBackground <output.png>\n", stderr)
  exit(2)
}

guard let bitmap = NSBitmapImageRep(
  bitmapDataPlanes: nil,
  pixelsWide: Int(logicalWidth * scale),
  pixelsHigh: Int(logicalHeight * scale),
  bitsPerSample: 8,
  samplesPerPixel: 4,
  hasAlpha: true,
  isPlanar: false,
  colorSpaceName: .deviceRGB,
  bitmapFormat: [],
  bytesPerRow: 0,
  bitsPerPixel: 0
) else {
  fputs("Could not create the DMG background bitmap.\n", stderr)
  exit(1)
}

bitmap.size = NSSize(width: logicalWidth, height: logicalHeight)

guard let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
  fputs("Could not create the DMG background context.\n", stderr)
  exit(1)
}

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context

let canvas = NSColor(srgbRed: 0.93, green: 0.91, blue: 0.97, alpha: 1)
let paper = NSColor(srgbRed: 0.98, green: 0.97, blue: 0.99, alpha: 1)
let lilac = NSColor(srgbRed: 0.54, green: 0.41, blue: 0.81, alpha: 1)
let lilacFaint = NSColor(srgbRed: 0.77, green: 0.69, blue: 0.91, alpha: 0.34)

canvas.setFill()
NSBezierPath(rect: NSRect(x: 0, y: 0, width: logicalWidth, height: logicalHeight)).fill()

// Finder does not scale custom folder backgrounds when its window grows. Keep
// the designed 720×460 composition at the image's top-left and extend the base
// color across a full 5K display's logical workspace.
NSGraphicsContext.saveGraphicsState()
context.cgContext.translateBy(x: 0, y: logicalHeight - designHeight)

drawSpiral(
  in: NSRect(x: -82, y: -92, width: 310, height: 310),
  color: NSColor(srgbRed: 0.54, green: 0.41, blue: 0.81, alpha: 0.08),
  lineWidth: 29
)

let topRule = NSBezierPath()
topRule.lineWidth = 1.5
topRule.move(to: NSPoint(x: 92, y: 391))
topRule.line(to: NSPoint(x: 310, y: 391))
topRule.move(to: NSPoint(x: 410, y: 391))
topRule.line(to: NSPoint(x: 628, y: 391))
lilacFaint.setStroke()
topRule.stroke()

drawSpiral(
  in: NSRect(x: 335, y: 366, width: 50, height: 50),
  color: lilac,
  lineWidth: 6.5
)

drawInstallSurface(in: NSRect(x: 120, y: 104, width: 170, height: 190), fill: paper)
drawInstallSurface(in: NSRect(x: 430, y: 104, width: 170, height: 190), fill: paper)

let arrow = NSBezierPath()
arrow.lineWidth = 3.5
arrow.lineCapStyle = .round
arrow.lineJoinStyle = .round
arrow.move(to: NSPoint(x: 320, y: 221))
arrow.line(to: NSPoint(x: 400, y: 221))
arrow.move(to: NSPoint(x: 387, y: 234))
arrow.line(to: NSPoint(x: 400, y: 221))
arrow.line(to: NSPoint(x: 387, y: 208))
lilac.setStroke()
arrow.stroke()

let bottomDots: [(CGFloat, CGFloat, CGFloat)] = [
  (347, 44, 3), (360, 44, 4.5), (374, 44, 3)
]
for (x, y, radius) in bottomDots {
  lilacFaint.setFill()
  NSBezierPath(ovalIn: NSRect(x: x - radius, y: y - radius, width: radius * 2, height: radius * 2)).fill()
}

NSGraphicsContext.restoreGraphicsState()
context.flushGraphics()
NSGraphicsContext.restoreGraphicsState()

guard let png = bitmap.representation(using: NSBitmapImageRep.FileType.png, properties: [:]) else {
  fputs("Could not encode the DMG background.\n", stderr)
  exit(1)
}

do {
  try png.write(
    to: URL(fileURLWithPath: CommandLine.arguments[1]),
    options: Data.WritingOptions.atomic
  )
} catch {
  fputs("Could not write the DMG background: \(error.localizedDescription)\n", stderr)
  exit(1)
}

private func drawInstallSurface(in rect: NSRect, fill: NSColor) {
  NSGraphicsContext.saveGraphicsState()
  let shadow = NSShadow()
  shadow.shadowBlurRadius = 16
  shadow.shadowOffset = NSSize(width: 0, height: -5)
  shadow.shadowColor = NSColor(srgbRed: 0.18, green: 0.16, blue: 0.21, alpha: 0.10)
  shadow.set()
  fill.setFill()
  NSBezierPath(roundedRect: rect, xRadius: 28, yRadius: 28).fill()
  NSGraphicsContext.restoreGraphicsState()

  lilacFaint.setStroke()
  let border = NSBezierPath(roundedRect: rect.insetBy(dx: 0.75, dy: 0.75), xRadius: 27, yRadius: 27)
  border.lineWidth = 1.5
  border.stroke()
}

private func drawSpiral(in rect: NSRect, color: NSColor, lineWidth: CGFloat) {
  let points: [(CGFloat, CGFloat)] = [
    (68.00, 64.00), (69.24, 67.23), (68.60, 70.04), (66.52, 72.67),
    (63.10, 74.43), (58.78, 74.70), (54.22, 73.08), (50.28, 69.49),
    (47.78, 64.20), (47.45, 57.85), (49.70, 51.35), (54.54, 45.78),
    (61.58, 42.17), (69.97, 41.37), (78.55, 43.87), (86.03, 49.67),
    (91.12, 58.26), (92.79, 68.63), (89.20, 81.98), (81.83, 91.04),
    (71.21, 97.05), (58.61, 98.85), (45.71, 95.82), (34.37, 88.01),
    (26.34, 76.18), (23.05, 61.74), (25.30, 46.56), (33.16, 32.77),
    (45.89, 22.45), (61.99, 17.28), (79.40, 18.32), (95.73, 25.82),
    (99.36, 28.64)
  ]
  let path = NSBezierPath()
  path.lineWidth = lineWidth
  path.lineCapStyle = .round
  path.lineJoinStyle = .round
  for (index, point) in points.enumerated() {
    let x = rect.minX + point.0 / 128 * rect.width
    let y = rect.minY + (128 - point.1) / 128 * rect.height
    if index == 0 {
      path.move(to: NSPoint(x: x, y: y))
    } else {
      path.line(to: NSPoint(x: x, y: y))
    }
  }
  color.setStroke()
  path.stroke()
}
