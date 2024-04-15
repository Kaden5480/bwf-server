let
    pkgs = import <nixpkgs> {};
in
    pkgs.mkShell {
        buildInputs = with pkgs; [
            nodejs_21
        ];

        shellHook = ''
        [ -d node_modules ] || npm i
        npm start
        '';
    }
