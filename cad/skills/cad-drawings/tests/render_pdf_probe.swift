import AppKit
import Foundation
import PDFKit

let input=CommandLine.arguments[1]
let output=URL(fileURLWithPath:CommandLine.arguments[2])
let preview=URL(fileURLWithPath:CommandLine.arguments[3])
let required=Array(CommandLine.arguments.dropFirst(4))
guard let image=NSImage(contentsOfFile:input) else { fputs("SVG load failed\n",stderr); exit(2) }
let pageSize=NSSize(width:842,height:595)
let page=NSView(frame:NSRect(origin:.zero,size:pageSize))
let imageView=NSImageView(frame:page.bounds)
imageView.image=image
imageView.imageScaling = .scaleProportionallyUpOrDown
page.addSubview(imageView)
let info=NSPrintInfo()
info.paperSize=pageSize
info.topMargin=0
info.bottomMargin=0
info.leftMargin=0
info.rightMargin=0
info.horizontalPagination = .fit
info.verticalPagination = .fit
info.jobDisposition = .save
info.dictionary()[NSPrintInfo.AttributeKey.jobSavingURL]=output
let operation=NSPrintOperation(view:page,printInfo:info)
operation.showsPrintPanel=false
operation.showsProgressPanel=false
guard operation.run() else { fputs("PDF print operation failed\n",stderr); exit(3) }
guard FileManager.default.fileExists(atPath:output.path), ((try? FileManager.default.attributesOfItem(atPath:output.path)[.size] as? NSNumber)?.intValue ?? 0)>0 else { fputs("PDF output missing or empty\n",stderr); exit(4) }
guard let pdf=PDFDocument(url:output), pdf.pageCount>0 else { fputs("Generated PDF cannot be parsed\n",stderr); exit(5) }
let pdfText=(0..<pdf.pageCount).compactMap{pdf.page(at:$0)?.string}.joined(separator:" ")
for field in required where !pdfText.contains(field) { fputs("PDF missing required field: \(field)\n",stderr); exit(6) }
guard let pdfPage=pdf.page(at:0), let pdfImage=pdfPage.thumbnail(of:CGSize(width:1684,height:1191),for:.mediaBox).cgImage(forProposedRect:nil,context:nil,hints:nil) else { fputs("PDF page render failed\n",stderr); exit(7) }
let bitmap=NSBitmapImageRep(cgImage:pdfImage)
guard let png=bitmap.representation(using:.png,properties:[:]) else { fputs("PDF PNG encode failed\n",stderr); exit(8) }
try png.write(to:preview)
print("PDF written, \(pdf.pageCount) page(s), text fields verified")
