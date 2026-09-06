package expo.modules.easydococr

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.net.Uri
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.korean.KoreanTextRecognizerOptions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class EasyDocOcrModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("EasyDocOcr")

    AsyncFunction("recognize") { uri: String, promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.reject("OCR_UNAVAILABLE", "문자 인식을 시작할 수 없습니다.", null)
      } else {
        try {
          val image = InputImage.fromFilePath(context, Uri.parse(uri))
          val recognizer = TextRecognition.getClient(KoreanTextRecognizerOptions.Builder().build())
          recognizer.process(image)
            .addOnSuccessListener { result -> promise.resolve(result.text) }
            .addOnFailureListener { error -> promise.reject("OCR_FAILED", "문자를 인식하지 못했습니다. 더 선명한 사진으로 시도해 주세요.", error) }
            .addOnCompleteListener { recognizer.close() }
        } catch (error: Exception) {
          promise.reject("OCR_IMAGE_FAILED", "이미지를 읽을 수 없습니다.", error)
        }
      }
    }

    AsyncFunction("copyText") { text: String ->
      val context = requireNotNull(appContext.reactContext)
      val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
      clipboard.setPrimaryClip(ClipData.newPlainText("EasyDoc", text))
    }
  }
}
