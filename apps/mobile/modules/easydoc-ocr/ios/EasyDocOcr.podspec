Pod::Spec.new do |s|
  s.name = 'EasyDocOcr'
  s.version = '1.0.0'
  s.summary = 'On-device text recognition'
  s.description = 'Korean and English text recognition for EasyDoc.'
  s.license = 'MIT'
  s.author = 'EasyDoc'
  s.homepage = 'https://easydoc.app'
  s.platforms = { :ios => '16.4' }
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Vision', 'UIKit'
  s.source_files = '**/*.swift'
end
