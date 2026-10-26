import AppKit
import Foundation

let input=CommandLine.arguments[1]
let output=URL(fileURLWithPath:CommandLine.arguments[2])
guard let image=NSImage(contentsOfFile:input) else { fputs("SVG load failed\n",stderr); exit(2) }
var proposed=CGRect(origin:.zero,size:image.size)
guard let source=image.cgImage(forProposedRect:&proposed,context:nil,hints:nil) else { fputs("SVG raster failed\n",stderr); exit(2) }
let width=source.width, height=source.height
let space=CGColorSpaceCreateDeviceRGB()
guard let context=CGContext(data:nil,width:width,height:height,bitsPerComponent:8,bytesPerRow:width*4,space:space,bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue) else { fputs("bitmap context failed\n",stderr); exit(2) }
context.setFillColor(NSColor.white.cgColor); context.fill(CGRect(x:0,y:0,width:width,height:height))
context.draw(source,in:CGRect(x:0,y:0,width:width,height:height))
guard let rendered=context.makeImage(), let png=NSBitmapImageRep(cgImage:rendered).representation(using:.png,properties:[:]) else { fputs("PNG encode failed\n",stderr); exit(2) }
try png.write(to:output)
var bytes=[UInt8](repeating:0,count:width*height*4)
let pixelContext=CGContext(data:&bytes,width:width,height:height,bitsPerComponent:8,bytesPerRow:width*4,space:space,bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)
pixelContext?.draw(rendered,in:CGRect(x:0,y:0,width:width,height:height))
var dark=0
for i in stride(from:0,to:bytes.count,by:4) where bytes[i] < 245 || bytes[i+1] < 245 || bytes[i+2] < 245 { dark += 1 }
print("size \(width)x\(height), dark_pixels \(dark), PNG bytes \(png.count)")
if dark < 200 { fputs("render appears blank\n",stderr); exit(3) }
