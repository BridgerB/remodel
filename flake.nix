{
  description = "remodel — local house image tools on an NVIDIA GPU: image->image (FLUX.2 klein-9b/ComfyUI) and image->text (gemma3:27b/Ollama).";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = {
    nixpkgs,
    ...
  }: let
    system = "x86_64-linux";
    pkgs = import nixpkgs {inherit system;};
    node = pkgs.nodejs_24; # runs .ts directly (type stripping, no flags). Client scripts talk to the servers over HTTP.

    # FHS sandbox so pip CUDA wheels (torch cu124) find libcuda on NixOS.
    # Only the ComfyUI server + bootstrap need this; the client scripts don't.
    fhs = pkgs.buildFHSEnv {
      name = "remodel-fhs";
      targetPkgs = p:
        with p; [
          python312
          gcc
          glibc
          zlib
          stdenv.cc.cc.lib
          libGL
          glib
          openssl
          file
          which
          git
          wget
          curl
          ffmpeg
          freetype
          libx11
          libxext
          ollama
          nodejs_24
        ];
      profile = ''
        export LD_LIBRARY_PATH=/run/opengl-driver/lib:$LD_LIBRARY_PATH
        export CUDA_VISIBLE_DEVICES=0
      '';
      runScript = "bash";
    };

    # Resolve the repo + data dir at runtime. data/ (models, venv, ComfyUI) is
    # gitignored and lives next to the working tree on the big drive.
    preamble = ''
      set -euo pipefail
      REPO="''${REMODEL_REPO:-$PWD}"
      DATA="''${REMODEL_DATA:-$REPO/data}"
      export REMODEL_REPO REMODEL_DATA="$DATA"
    '';

    ensureComfy = ''
      if ! ${pkgs.curl}/bin/curl -sf http://127.0.0.1:8189/object_info >/dev/null 2>&1; then
        echo "starting ComfyUI server (cold start takes ~30s)..." >&2
        ${fhs}/bin/remodel-fhs -c "cd '$DATA/ComfyUI' && exec '$DATA/venv/bin/python' main.py --listen 127.0.0.1 --port 8189 --lowvram --disable-auto-launch" >"$DATA/comfy.log" 2>&1 &
        for i in $(seq 1 60); do ${pkgs.curl}/bin/curl -sf http://127.0.0.1:8189/object_info >/dev/null 2>&1 && break; sleep 2; done
      fi
    '';

    ensureOllama = ''
      if ! ${pkgs.curl}/bin/curl -sf http://127.0.0.1:11435/api/tags >/dev/null 2>&1; then
        echo "starting Ollama (models in $DATA/ollama)..." >&2
        OLLAMA_MODELS="$DATA/ollama" OLLAMA_HOST=127.0.0.1:11435 ollama serve >"$DATA/ollama.log" 2>&1 &
        for i in $(seq 1 30); do ${pkgs.curl}/bin/curl -sf http://127.0.0.1:11435/api/tags >/dev/null 2>&1 && break; sleep 2; done
      fi
    '';

    app = name: text: {
      type = "app";
      program = toString (pkgs.writeShellScript "remodel-${name}" text);
    };
  in {
    packages.${system} = {
      fhs = fhs;
      default = fhs;
    };

    apps.${system} = {
      # One-time setup: downloads ComfyUI + venv + FLUX models + gemma3 into ./data.
      bootstrap = app "bootstrap" ''
        ${preamble}
        exec ${fhs}/bin/remodel-fhs -c "cd '$REPO/services' && REMODEL_DATA='$DATA' node bootstrap.ts"
      '';

      # image -> image remodel (FLUX.2 klein-9b). Usage: nix run .#remodel -- --image X --prompt "..."
      remodel = app "remodel" ''
        ${preamble}
        ${ensureComfy}
        exec ${node}/bin/node "$REPO/services/remodel.ts" "$@"
      '';

      # image -> text description (gemma3:27b). Usage: nix run .#describe -- --image X
      describe = app "describe" ''
        ${preamble}
        ${ensureOllama}
        exec ${node}/bin/node "$REPO/services/describe.ts" "$@"
      '';

      # HTTP API serving BOTH (POST /describe, POST /remodel). localhost:8090
      api = app "api" ''
        ${preamble}
        ${ensureOllama}
        ${ensureComfy}
        exec ${node}/bin/node "$REPO/services/api.ts" "$@"
      '';

      # format + lint the services TypeScript with Biome
      fmt = app "fmt" ''
        ${preamble}
        exec ${pkgs.biome}/bin/biome check --write "$REPO/services"
      '';
      lint = app "lint" ''
        ${preamble}
        exec ${pkgs.biome}/bin/biome check "$REPO/services"
      '';

      # long-running servers, if you want them up explicitly
      serve-comfy = app "serve-comfy" ''
        ${preamble}
        exec ${fhs}/bin/remodel-fhs -c "cd '$DATA/ComfyUI' && exec '$DATA/venv/bin/python' main.py --listen 127.0.0.1 --port 8189 --lowvram --disable-auto-launch"
      '';
      serve-ollama = app "serve-ollama" ''
        ${preamble}
        OLLAMA_MODELS="$DATA/ollama" OLLAMA_HOST=127.0.0.1:11435 exec ollama serve
      '';

      default = app "help" ''
        cat <<'TXT'
        remodel — local house image tools (NVIDIA GPU, NixOS)

          nix run .#bootstrap            one-time setup (models, venv, ComfyUI)
          nix run .#describe -- --image house.jpg
          nix run .#remodel  -- --image house.jpg --prompt "fresh paint, green lawn..."
          nix run .#api                  HTTP API on :8090 (POST /describe, /remodel)

        Data (models/venv) lives in ./data (gitignored). Override with REMODEL_DATA.
        TXT
      '';
    };
  };
}
