# Adds Shelf's Apple Watch app to the Xcode project (ios/App/App.xcodeproj), once; running it again changes nothing.
#   ruby dev/watch-target.rb      (needs the xcodeproj gem: gem install xcodeproj)
# - ShelfWatch: a watchOS 10 SwiftUI app (ios/App/ShelfWatch), embedded in the iPhone app, its bundle id the iPhone's + .watchkitapp
# - ShelfWatchKit (ios/ShelfWatchKit): a local Swift package both apps link
# - ShelfWatch.swift (the iPhone's end of the link) in the App target
# - SHELF_BUNDLE_ID: one setting for the bundle id, so the installer and TestFlight change it in one place for both apps
require 'xcodeproj'

root = File.expand_path('..', __dir__)
proj_path = File.join(root, 'ios/App/App.xcodeproj')
p = Xcodeproj::Project.open(proj_path)
app = p.targets.find { |t| t.name == 'App' } or abort 'No App target'

# One bundle id setting for both apps
p.build_configurations.each { |c| c.build_settings['SHELF_BUNDLE_ID'] ||= 'com.mokingsacc.shelf' }
app.build_configurations.each { |c| c.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] = '$(SHELF_BUNDLE_ID)' }

# The shared package
pkg = p.root_object.package_references.find { |r| r.respond_to?(:relative_path) && r.relative_path == '../ShelfWatchKit' }
unless pkg
  pkg = p.new(Xcodeproj::Project::Object::XCLocalSwiftPackageReference)
  pkg.relative_path = '../ShelfWatchKit'
  p.root_object.package_references << pkg
end
def link_kit(p, target, pkg)
  return if target.package_product_dependencies.any? { |d| d.product_name == 'ShelfWatchKit' }
  dep = p.new(Xcodeproj::Project::Object::XCSwiftPackageProductDependency)
  dep.product_name = 'ShelfWatchKit'
  dep.package = pkg
  target.package_product_dependencies << dep
  bf = p.new(Xcodeproj::Project::Object::PBXBuildFile)
  bf.product_ref = dep
  target.frameworks_build_phase.files << bf
end
link_kit(p, app, pkg)

# The iPhone's end of the link
app_group = p.main_group.children.find { |g| g.display_name == 'App' }
unless app.source_build_phase.files_references.any? { |f| f.path == 'ShelfWatch.swift' }
  ref = app_group.files.find { |f| f.path == 'ShelfWatch.swift' } || app_group.new_reference('ShelfWatch.swift')
  app.source_build_phase.add_file_reference(ref)
end

# The watch app
watch = p.targets.find { |t| t.name == 'ShelfWatch' }
unless watch
  watch = p.new_target(:application, 'ShelfWatch', :watchos, '10.0', p.products_group, :swift)
  group = p.main_group.children.find { |g| g.display_name == 'ShelfWatch' } || p.main_group.new_group('ShelfWatch', 'ShelfWatch')
  Dir.glob(File.join(root, 'ios/App/ShelfWatch/*.swift')).sort.each do |f|
    watch.source_build_phase.add_file_reference(group.new_reference(File.basename(f)))
  end
  watch.resources_build_phase.add_file_reference(group.new_reference('Assets.xcassets'))
  watch.resources_build_phase.add_file_reference(group.new_reference('Resources/demo.json'))
  group.new_reference('Info.plist')
end
# Files added since the target was made
group = p.main_group.children.find { |g| g.display_name == 'ShelfWatch' }
Dir.glob(File.join(root, 'ios/App/ShelfWatch/*.swift')).sort.each do |f|
  name = File.basename(f)
  next if watch.source_build_phase.files_references.any? { |r| r.path == name }
  watch.source_build_phase.add_file_reference(group.new_reference(name))
end
watch.build_configurations.each do |c|
  s = c.build_settings
  s['PRODUCT_BUNDLE_IDENTIFIER'] = '$(SHELF_BUNDLE_ID).watchkitapp'
  s['PRODUCT_NAME'] = 'ShelfWatch'
  s['INFOPLIST_FILE'] = 'ShelfWatch/Info.plist'
  s['GENERATE_INFOPLIST_FILE'] = 'NO'
  s['SDKROOT'] = 'watchos'
  s['WATCHOS_DEPLOYMENT_TARGET'] = '10.0'
  s['TARGETED_DEVICE_FAMILY'] = '4'
  s['SWIFT_VERSION'] = '5.0'
  s['ASSETCATALOG_COMPILER_APPICON_NAME'] = 'AppIcon'
  s['CODE_SIGN_STYLE'] = 'Automatic'
  s['SKIP_INSTALL'] = 'YES'
  s['MARKETING_VERSION'] = '1.0'
  s['CURRENT_PROJECT_VERSION'] = '1'
  s['ENABLE_PREVIEWS'] = 'YES'
  s.delete('ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME')
  s['LD_RUNPATH_SEARCH_PATHS'] = ['$(inherited)', '@executable_path/Frameworks']
  s.delete('IPHONEOS_DEPLOYMENT_TARGET')
end
link_kit(p, watch, pkg)

# Embedded in the iPhone app, built with it
app.add_dependency(watch) unless app.dependencies.any? { |d| d.target == watch }
embed = app.copy_files_build_phases.find { |ph| ph.name == 'Embed Watch Content' }
unless embed
  embed = app.new_copy_files_build_phase('Embed Watch Content')
  embed.dst_subfolder_spec = '16'
  embed.dst_path = '$(CONTENTS_FOLDER_PATH)/Watch'
  bf = embed.add_file_reference(watch.product_reference)
  bf.settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }
end

p.save

# A shared scheme for the watch alone (CI builds it for the simulator and takes the screenshots)
scheme_dir = File.join(proj_path, 'xcshareddata/xcschemes')
unless File.exist?(File.join(scheme_dir, 'ShelfWatch.xcscheme'))
  sc = Xcodeproj::XCScheme.new
  sc.add_build_target(watch)
  sc.set_launch_target(watch)
  sc.save_as(proj_path, 'ShelfWatch', true)
end
puts 'Shelf watch target ready'
