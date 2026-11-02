// Regenerate the vector-drawn icon: swift scripts/generate-academy-icon.swift
import CoreGraphics
import ImageIO
import Foundation
import UniformTypeIdentifiers

let size = 1024
let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
context.setFillColor(CGColor(red: 14.0 / 255, green: 42.0 / 255, blue: 71.0 / 255, alpha: 1))
context.fill(CGRect(x: 0, y: 0, width: size, height: size))
context.setStrokeColor(CGColor(gray: 1, alpha: 0.035))
context.setLineWidth(1)
for n in stride(from: 32, to: size, by: 64) {
    context.move(to: CGPoint(x: n, y: 0)); context.addLine(to: CGPoint(x: n, y: size))
    context.move(to: CGPoint(x: 0, y: n)); context.addLine(to: CGPoint(x: size, y: n))
}
context.strokePath()
context.setStrokeColor(CGColor(gray: 1, alpha: 0.16))
context.setLineWidth(3)
for diameter in [610, 780] {
    context.strokeEllipse(in: CGRect(x: (size - diameter) / 2, y: (size - diameter) / 2, width: diameter, height: diameter))
}
context.setStrokeColor(CGColor(red: 229.0 / 255, green: 202.0 / 255, blue: 118.0 / 255, alpha: 1))
context.setLineWidth(15); context.setLineCap(.round)
context.addArc(center: CGPoint(x: 512, y: 512), radius: 390, startAngle: .pi / 12, endAngle: .pi * 0.43, clockwise: false)
context.strokePath()
context.translateBy(x: 512, y: 512)
context.rotate(by: -.pi / 4)
context.scaleBy(x: 0.85, y: 0.85)
context.translateBy(x: -512, y: -512)
let points: [(CGFloat, CGFloat)] = [(512,820),(535,770),(540,580),(775,420),(775,365),(540,445),(535,285),(610,230),(610,195),(512,223),(414,195),(414,230),(489,285),(484,445),(249,365),(249,420),(484,580),(489,770)]
context.move(to: CGPoint(x: points[0].0, y: points[0].1))
for p in points.dropFirst() { context.addLine(to: CGPoint(x: p.0, y: p.1)) }
context.closePath(); context.setFillColor(CGColor(gray: 1, alpha: 1)); context.fillPath()
let image = context.makeImage()!
let path = "ios/BiotechSignal/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png"
let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(destination, image, nil)
precondition(CGImageDestinationFinalize(destination))
print("Wrote Academy icon")
