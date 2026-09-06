import ExpoModulesCore
import Vision
import UIKit

public class EasyDocOcrModule: Module {
  public func definition() -> ModuleDefinition {
    Name("EasyDocOcr")

    AsyncFunction("recognize") { (uri: String) -> String in
      guard let url = URL(string: uri), url.isFileURL else {
        throw NSError(domain: "EasyDocOcr", code: 1, userInfo: [NSLocalizedDescriptionKey: "이미지를 읽을 수 없습니다."])
      }
      let request = VNRecognizeTextRequest()
      request.recognitionLevel = .accurate
      request.recognitionLanguages = ["ko-KR", "en-US"]
      request.usesLanguageCorrection = true
      try VNImageRequestHandler(url: url).perform([request])
      return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
    }

    AsyncFunction("copyText") { (text: String) in
      UIPasteboard.general.string = text
    }.runOnQueue(.main)
  }
}
