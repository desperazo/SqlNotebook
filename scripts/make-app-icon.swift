// Converts an app-icon artwork (JPG/PNG, any size) into a 1024x1024 RGBA PNG
// laid out on the macOS icon grid: 824x824 rounded-square artwork centered on
// a transparent canvas. Usage: swift make-app-icon.swift <input> <output>
import Foundation
import CoreGraphics
import ImageIO

let args = CommandLine.arguments
guard args.count >= 3 else {
    print("usage: swift make-app-icon.swift <input-image> <output-png>")
    exit(2)
}
let srcPath = args[1]
let outPath = args[2]

guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: srcPath) as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
    fatalError("cannot read \(srcPath)")
}
let w = image.width
let h = image.height
let cs = CGColorSpace(name: CGColorSpace.sRGB)!
guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8,
                          bytesPerRow: w * 4, space: cs,
                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
      let buf = ctx.data else {
    fatalError("cannot build pixel context")
}
ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
let px = buf.bindMemory(to: UInt8.self, capacity: w * h * 4)

func colorAt(_ x: Int, _ y: Int) -> (r: Int, g: Int, b: Int) {
    let i = (y * w + x) * 4
    return (Int(px[i]), Int(px[i + 1]), Int(px[i + 2]))
}

func avgColor(_ x0: Int, _ y0: Int, _ s: Int) -> (r: Int, g: Int, b: Int) {
    var r = 0, g = 0, b = 0, n = 0
    for y in y0..<(y0 + s) {
        for x in x0..<(x0 + s) {
            let c = colorAt(x, y)
            r += c.r; g += c.g; b += c.b; n += 1
        }
    }
    return (r / n, g / n, b / n)
}

// Background = average of the four image corners; the artwork is everything
// that differs from it by more than the threshold.
let corners = [avgColor(0, 0, 12), avgColor(w - 12, 0, 12),
               avgColor(0, h - 12, 12), avgColor(w - 12, h - 12, 12)]
let bg = (r: corners.map(\.r).reduce(0, +) / 4,
          g: corners.map(\.g).reduce(0, +) / 4,
          b: corners.map(\.b).reduce(0, +) / 4)
let spread = corners.map { max(abs($0.r - bg.r), abs($0.g - bg.g), abs($0.b - bg.b)) }.max()!
print("corners: \(corners) spread=\(spread)")
guard spread < 6 else {
    fatalError("background is not uniform (\(spread)); adjust threshold handling")
}

func isArt(_ x: Int, _ y: Int, _ thr: Int) -> Bool {
    let c = colorAt(x, y)
    return max(abs(c.r - bg.r), abs(c.g - bg.g), abs(c.b - bg.b)) > thr
}

let thr = 14
var minX = w, maxX = -1, minY = h, maxY = -1
for y in 0..<h {
    for x in 0..<w where isArt(x, y, thr) {
        if x < minX { minX = x }
        if x > maxX { maxX = x }
        if y < minY { minY = y }
        if y > maxY { maxY = y }
    }
}
print("bbox: (\(minX),\(minY))-(\(maxX),\(maxY)) size \(maxX - minX + 1)x\(maxY - minY + 1) of \(w)x\(h)")
guard minX < maxX, minY < maxY else { fatalError("no artwork found") }

// Edge probes through the artwork center to confirm the bbox is the square
// itself (a drop shadow would push the bottom edge out of shape).
let cx = (minX + maxX) / 2
let cy = (minY + maxY) / 2
var probeMinX = w, probeMaxX = -1, probeMinY = h, probeMaxY = -1
for x in 0..<w where isArt(x, cy, thr) {
    probeMinX = min(probeMinX, x); probeMaxX = max(probeMaxX, x)
}
for y in 0..<h where isArt(cx, y, thr) {
    probeMinY = min(probeMinY, y); probeMaxY = max(probeMaxY, y)
}
print("center probes: x \(probeMinX)-\(probeMaxX)  y \(probeMinY)-\(probeMaxY)")

// Corner radius: on a row a few px into the artwork, the first art pixel sits
// ~radius px in from the left edge.
var rEst = 0
scan: for y in (minY + 2)...(minY + 400) {
    for x in minX...(minX + 500) where isArt(x, y, thr) {
        rEst = x - minX
        break scan
    }
}
print("radius estimate: \(rEst)px")

let rectW = maxX - minX + 1
let rectH = maxY - minY + 1
let side = max(rectW, rectH)
let crop = CGRect(x: cx - side / 2, y: cy - side / 2, width: side, height: side)
guard let cropped = image.cropping(to: crop) else { fatalError("crop failed") }

// macOS grid: 1024 canvas, 824 artwork.
let outSize = 1024
let art = 824
let margin = (outSize - art) / 2
var radius = CGFloat(rEst) * CGFloat(art) / CGFloat(side)
radius = min(radius * 0.96, CGFloat(art) * 0.2237)
print("render: side=\(side) radius=\(Int(radius))px on \(outSize)x\(outSize)")

guard let outCtx = CGContext(data: nil, width: outSize, height: outSize, bitsPerComponent: 8,
                             bytesPerRow: outSize * 4, space: cs,
                             bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
    fatalError("output context")
}
let artRect = CGRect(x: margin, y: margin, width: art, height: art)
outCtx.addPath(CGPath(roundedRect: artRect, cornerWidth: radius, cornerHeight: radius, transform: nil))
outCtx.clip()
outCtx.interpolationQuality = .high
outCtx.draw(cropped, in: artRect)
guard let outImage = outCtx.makeImage(),
      let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: outPath) as CFURL,
                                                 "public.png" as CFString, 1, nil) else {
    fatalError("png writer")
}
CGImageDestinationAddImage(dest, outImage, nil)
guard CGImageDestinationFinalize(dest) else { fatalError("png write failed") }
print("wrote \(outPath)")
