{ pkgs }: {
  deps = [
    # Node.js runtime
    pkgs.nodejs_20
    pkgs.nodePackages.npm

    # FFmpeg — provides the ffmpeg binary at runtime
    # This replaces the bundled platform-specific binaries
    pkgs.ffmpeg-full

    # Electron runtime dependencies
    pkgs.electron_28
    pkgs.xorg.libX11
    pkgs.xorg.libXcomposite
    pkgs.xorg.libXdamage
    pkgs.xorg.libXext
    pkgs.xorg.libXfixes
    pkgs.xorg.libXrandr
    pkgs.xorg.libXrender
    pkgs.xorg.libXtst
    pkgs.xorg.libxcb
    pkgs.xorg.libxshmfence
    pkgs.mesa
    pkgs.libdrm
    pkgs.nss
    pkgs.nspr
    pkgs.atk
    pkgs.at-spi2-atk
    pkgs.cups
    pkgs.dbus
    pkgs.expat
    pkgs.glib
    pkgs.gtk3
    pkgs.pango
    pkgs.cairo
    pkgs.alsa-lib
    pkgs.libxkbcommon

    # Build tools
    pkgs.pkg-config
    pkgs.python3
    pkgs.gcc
    pkgs.gnumake

    # TypeScript / JS tooling
    pkgs.nodePackages.typescript-language-server
  ];

  env = {
    ELECTRON_DISABLE_SANDBOX = "1";
    LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath [
      pkgs.xorg.libX11
      pkgs.xorg.libXcomposite
      pkgs.xorg.libXdamage
      pkgs.xorg.libXext
      pkgs.xorg.libXfixes
      pkgs.xorg.libXrandr
      pkgs.xorg.libXrender
      pkgs.xorg.libXtst
      pkgs.xorg.libxcb
      pkgs.xorg.libxshmfence
      pkgs.mesa
      pkgs.libdrm
      pkgs.nss
      pkgs.nspr
      pkgs.atk
      pkgs.at-spi2-atk
      pkgs.cups
      pkgs.dbus
      pkgs.expat
      pkgs.glib
      pkgs.gtk3
      pkgs.pango
      pkgs.cairo
      pkgs.alsa-lib
      pkgs.libxkbcommon
    ];
  };
}
