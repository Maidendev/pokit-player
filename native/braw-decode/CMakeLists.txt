cmake_minimum_required(VERSION 3.16)
project(braw-decode CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

# The SDK is not in the repository — it is a payload inside Blackmagic's
# installer and the download needs a Blackmagic account. scripts/extract-braw-sdk.sh
# unpacks it here. See README.md.
set(BRAW_SDK "${CMAKE_CURRENT_SOURCE_DIR}/sdk")

if(APPLE)
  set(BRAW_INCLUDE "${BRAW_SDK}/Mac/Include")
  set(BRAW_LIBS "${BRAW_SDK}/Mac/Libraries")
elseif(WIN32)
  set(BRAW_INCLUDE "${BRAW_SDK}/Win/Include")
  set(BRAW_LIBS "${BRAW_SDK}/Win")
else()
  set(BRAW_INCLUDE "${BRAW_SDK}/Linux/Include")
  set(BRAW_LIBS "${BRAW_SDK}/Linux")
endif()

if(NOT EXISTS "${BRAW_INCLUDE}")
  message(FATAL_ERROR
    "Blackmagic RAW SDK headers not found at ${BRAW_INCLUDE}.\n"
    "Put the Blackmagic RAW installer in native/braw-decode/sdk/ and run\n"
    "  scripts/extract-braw-sdk.sh")
endif()

set(BRAW_SOURCES braw-decode.cpp)

# On Windows the SDK is reached through a generated COM dispatch translation
# unit rather than a link library, so it compiles into the binary.
if(WIN32 AND EXISTS "${BRAW_INCLUDE}/BlackmagicRawAPIDispatch.cpp")
  list(APPEND BRAW_SOURCES "${BRAW_INCLUDE}/BlackmagicRawAPIDispatch.cpp")
endif()

add_executable(braw-decode ${BRAW_SOURCES})
target_include_directories(braw-decode PRIVATE "${BRAW_INCLUDE}")

if(APPLE)
  # Universal, to match the separate Intel and Apple Silicon app bundles. The
  # shipped framework carries both slices, so this costs nothing extra.
  if(NOT CMAKE_OSX_ARCHITECTURES)
    set_target_properties(braw-decode PROPERTIES OSX_ARCHITECTURES "x86_64;arm64")
  endif()

  find_library(CORE_FOUNDATION CoreFoundation REQUIRED)
  target_link_libraries(braw-decode PRIVATE ${CORE_FOUNDATION})

  # The framework must be LINKED, not merely present. Its only exported entry
  # point is CreateBlackmagicRawFactoryInstance — the ...FromPath and
  # ...FromExeRelativePath variants the SDK's own samples call are declared in
  # the header but absent from the macOS framework binary (check with
  # `nm -gU`). So the dynamic loader resolves it, and @loader_path is what
  # lets it be found beside the executable in the shipped app.
  target_link_directories(braw-decode PRIVATE "${BRAW_LIBS}")
  target_link_options(braw-decode PRIVATE
    "-F${BRAW_LIBS}"
    "-framework" "BlackmagicRawAPI"
    "-Wl,-rpath,@loader_path")
elseif(UNIX)
  target_link_libraries(braw-decode PRIVATE dl pthread)
  target_link_options(braw-decode PRIVATE "-Wl,-rpath,$ORIGIN")
endif()

# Land straight in src/bin, which is where src/braw.js looks and which
# electron-builder's asarUnpack already keeps outside the archive.
set_target_properties(braw-decode PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/../../src/bin"
  RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_CURRENT_SOURCE_DIR}/../../src/bin")

# Copy the runtime library next to the binary so a shipped build can find it
# without the SDK tree present.
if(APPLE AND EXISTS "${BRAW_LIBS}/BlackmagicRawAPI.framework")
  add_custom_command(TARGET braw-decode POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_directory
      "${BRAW_LIBS}/BlackmagicRawAPI.framework"
      "${CMAKE_CURRENT_SOURCE_DIR}/../../src/bin/BlackmagicRawAPI.framework"
    COMMENT "Copying BlackmagicRawAPI.framework into src/bin")
endif()
