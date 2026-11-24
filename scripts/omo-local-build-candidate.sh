#!/usr/bin/bash
# Prepare a Linux candidate only. See omo-local-build.md for the separate QA gate.
set -euo pipefail
PATH=/usr/bin:/bin

die() { printf '%s\n' "$*" >&2; exit 1; }
usage='Usage: bash scripts/omo-local-build-candidate.sh [--preflight] [--nicknames]'
preflight=false
nicknames=false
for arg in "$@"; do
	case "$arg" in
		-h|--help) printf '%s\n' "$usage"; exit 0 ;;
		--preflight) preflight=true ;;
		--nicknames) nicknames=true ;;
		*) die "$usage" ;;
	esac
done

scripts=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
root=$(cd -- "$scripts/.." && pwd -P)
state=${OMO_SENPI_BUILD_HOME:-"$HOME/.local/share/omo-local-builds/senpi"}
releases="$state/recipe"
bun="$state/toolchain/bun"
node=${OMO_SENPI_NODE:-"$HOME/.nvm/versions/node/v24.22.2/bin/node"}
desktop="$HOME/.omo/binary-runtime/5.1.78/native/prebuilds/linux-x64/senpi-desktop-engine"
base=c51802622c99f693cdd28b57d53b9217dafbcab7
omo_sha=5cb1e0154b464e75f06cef7e8dec588f2d6fc401
engine_sha=2c28cd8c166542e116e7a1f51412d419fb6f1b97
omo_version=5.1.78
engine_version=2026.11.18-2
nickname_base=1ad093b235b03ad6554f9bf15a26d7ecb682db70
nickname_head=04b67277ac72e6c9f4868d057684fab0633f156d
nickname_repo=${OMO_NICKNAME_SOURCE:-"$HOME/dev/omo"}
senpi_nickname_head=d7f427824455729066bdaf3a86e0884bffff04f4

[[ "$(uname -sm)" == "Linux x86_64" && -x "$bun" && -x "$node" ]] ||
	die "Expected Linux x64 and the retained standalone Bun and Node binaries"
umask 077
mkdir -p -- "$state/runs"
run=$(mktemp -d "$state/runs/run.XXXXXXXX")
scratch=$(mktemp -d /tmp/omo-dense.XXXXXXXX)
printf 'Build log: %s/build.log\n' "$run"
exec 3>&1
exec >"$run/build.log" 2>&1
cleanup() {
	local status=$?
	rm -rf -- "$scratch"
	if (( status != 0 )); then tail -n 25 "$run/build.log" >&3; fi
	exit "$status"
}
trap cleanup EXIT

home="$scratch/home"
mkdir -p "$home" "$scratch/tmp"
tool_path="${bun%/*}:${node%/*}:/usr/bin:/bin"
clean() {
	/usr/bin/env -i "PATH=$tool_path" "HOME=$home" "USERPROFILE=$home" "TMPDIR=$scratch/tmp" \
		LANG=C.UTF-8 CI=1 PI_OFFLINE=1 OMO_DISABLE_TELEMETRY=1 SENPI_OMO_LOCAL_UPDATE=0 \
		GIT_MASTER=1 GIT_OPTIONAL_LOCKS=0 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
		GIT_TERMINAL_PROMPT=0 "$@"
}
g() { GIT_MASTER=1 clean /usr/bin/git "$@"; }
step() { printf '%s\n' "$1"; printf '%s\n' "$1" >&3; }
verify_hash() { printf '%s  %s\n' "$1" "$2" | sha256sum --check --status; }

[[ "$(clean "$bun" --version)" == 1.4.4 && "$(clean "$node" --version)" == v24.22.2 ]] ||
	die "Expected Bun 1.4.4 and Node 24.22.2"
printf 'OmO %s %s\nSenpi %s %s\n' "$omo_version" "$omo_sha" "$engine_version" "$engine_sha"
verify_hash 1cfcd93569e3418124076aee70a6dc111b18a3fa4feca3c60f2dab65b3e81b39 "$desktop" ||
	die "Pinned desktop sidecar checksum mismatch"
g -C "$root" merge-base --is-ancestor "$base" HEAD
if "$nicknames"; then
	g -C "$root" merge-base --is-ancestor "$senpi_nickname_head" HEAD ||
		die "Nickname deployment requires the verified Senpi adapter"
	g -C "$root" diff --quiet "$senpi_nickname_head" -- packages scripts/lint-ratchet.baseline.json scripts/realm-census.json ||
		die "Nickname deployment requires the verified Senpi runtime patch"
	[[ -z $(g -C "$root" ls-files --others --exclude-standard -- packages) ]] ||
		die "Nickname deployment cannot include untracked package files"
fi

step "Exporting the shared Senpi patch"
patch="$run/senpi.patch"
# Fork ledgers document the source changes but are not carried into the release overlay.
package_paths=(packages ':(exclude,glob)packages/**/changes.md')
g -C "$root" diff --no-ext-diff --no-textconv --binary --no-renames "$base" -- "${package_paths[@]}" >"$patch"
g -C "$root" ls-files --others --exclude-standard -z -- "${package_paths[@]}" >"$scratch/untracked"
while IFS= read -r -d '' file; do
	[[ -f "$root/$file" && ! -L "$root/$file" ]] || die "Not a regular file: $file"
	status=0
	g -C "$root" diff --no-index --binary -- /dev/null "$file" >>"$patch" || status=$?
	[[ "$status" == 1 ]] || die "Unable to export new file: $file"
done <"$scratch/untracked"
[[ -s "$patch" ]] || die "No Senpi patch to build"
sha256sum "$patch"

g -C "$root" apply --numstat -z "$patch" >"$scratch/numstat"
source_checks_patch="$run/source-checks.patch"
g -C "$root" diff --no-ext-diff --no-textconv --binary --no-renames "$base" -- \
	scripts/lint-ratchet.baseline.json scripts/realm-census.json >"$source_checks_patch"
sha256sum "$source_checks_patch"
coding_tests=()
codemode_tests=()
while IFS= read -r -d '' record; do
	file=${record#*$'\t'}
	file=${file#*$'\t'}
	case "$file" in
		packages/coding-agent/src/*.ts|packages/tui/src/*.ts|packages/senpi-codemode/src/*.ts)
			[[ -f "$root/$file" && ! -L "$root/$file" ]] || die "Unsupported deleted or linked runtime file: $file"
			printf '%s\0' "$file" ;;
		packages/coding-agent/test/suite/*.test.ts|packages/coding-agent/test/suite/regressions/*.test.ts)
			coding_tests+=("${file#packages/coding-agent/}") ;;
		packages/senpi-codemode/test/*.test.ts) codemode_tests+=("${file#packages/senpi-codemode/}") ;;
		packages/coding-agent/test/*|packages/coding-agent/docs/*|packages/tui/test/*|packages/senpi-codemode/test/*) ;;
		*) die "Outside this recipe's supported patch scope: $file" ;;
	esac
done <"$scratch/numstat" >"$run/runtime-paths"
[[ -s "$run/runtime-paths" ]] || die "No runtime paths in Senpi patch"

checkout() {
	g clone --quiet --no-checkout --no-hardlinks --template= -- "$1" "$3"
	g -C "$3" checkout --quiet --detach "$2"
	[[ "$(g -C "$3" rev-parse HEAD)" == "$2" ]] || die "Unexpected checkout: $3"
}

step "Checking the reviewed OmO canvas adjustment"
checkout "$releases/omo.git" "$omo_sha" "$scratch/omo"
cp -- "$releases/packager.patch" "$run/packager.patch"
verify_hash 4ca5de7880cb40ddb8b51aaa28e8c1557e56556b971cf54c661461b9b43d70bb "$run/packager.patch" ||
	die "The retained OmO packager patch differs from the reviewed canvas adjustment"
(
	cd "$scratch/omo"
	clean "$node" -e '
		const pkg = require("./packages/omo-native/package.json");
		if (pkg.version !== process.argv[1] || pkg.dependencies["@code-yeongyu/senpi"] !== process.argv[2]) {
			throw Error("OmO package pins differ from the local build recipe");
		}
	' "$omo_version" "$engine_version"
)
g -C "$scratch/omo" apply --check "$run/packager.patch"
if "$nicknames"; then
	step "Checking the exact published OmO nickname source overlay"
	g -C "$nickname_repo" merge-base --is-ancestor "$nickname_base" "$nickname_head" || die "Unexpected producer ancestry"
	g -C "$nickname_repo" diff --no-ext-diff --no-textconv --binary --no-renames "$nickname_base^" "$nickname_head" -- \
		packages/omo-config-core/src packages/omo-senpi/src packages/senpi-task/src >"$run/omo-nicknames.patch"
	verify_hash 795eddb2b7ce84132f41f7dab542c2b4ecc0a5bdea2aa3db36aa2a7b822fb86d "$run/omo-nicknames.patch" ||
		die "Unexpected producer source patch"
	g -C "$scratch/omo" apply --check "$run/omo-nicknames.patch"
	g -C "$scratch/omo" apply "$run/omo-nicknames.patch"
	printf '%s\n%s\n' "$nickname_head" "$senpi_nickname_head" >"$run/nickname-pins"
	coding_tests=(test/suite/omo-task-density.test.ts)
	codemode_tests=()
fi

step "Checking the real patch on the workspace base and the pinned Senpi release"
checkout "$root" "$base" "$scratch/source"
checkout "$releases/engine.git" "$engine_sha" "$scratch/engine"
g -C "$scratch/source" apply --check "$patch"
g -C "$scratch/engine" apply --check "$patch"
if [[ -s "$source_checks_patch" ]]; then
	g -C "$scratch/source" apply --check "$source_checks_patch"
fi
if "$preflight"; then
	step "Patch preflight passed; no installs, builds or packaging were run"
	exit 0
fi

g -C "$scratch/source" apply "$patch"
if [[ -s "$source_checks_patch" ]]; then
	g -C "$scratch/source" apply "$source_checks_patch"
fi
g -C "$scratch/engine" apply "$patch"
g -C "$scratch/omo" apply "$run/packager.patch"
step "Running static checks and focused tests on the isolated source tree"
(
	cd "$scratch/source"
	clean "$bun" --no-env-file install --frozen-lockfile --ignore-scripts
	clean "$bun" --no-env-file run check
	if (( ${#coding_tests[@]} )); then
		(cd packages/coding-agent; clean "$bun" --no-env-file run test --reporter=default "${coding_tests[@]}")
	fi
	if (( ${#codemode_tests[@]} )); then
		(cd packages/senpi-codemode; clean "$node" ../../scripts/run-tests.mjs vitest run "${codemode_tests[@]}")
	fi
)
step "Building the pinned Senpi engine in its disposable checkout"
(
	cd "$scratch/engine"
	clean "$bun" --no-env-file install --frozen-lockfile --ignore-scripts
	clean "$bun" --no-env-file run build
)
(
	cd "$scratch/omo"
	clean "$bun" --no-env-file install --frozen-lockfile --ignore-scripts
	if "$nicknames"; then
		step "Type-checking and testing the OmO nickname result producers"
		clean "$bun" --no-env-file check --no-script --all -p packages/omo-senpi/tsconfig.json
		clean "$bun" --no-env-file test --timeout 20000 \
			./packages/omo-config-core/src/schema/task-nicknames.test.ts \
			./packages/senpi-task/src/manager/manager-fallback.test.ts \
			./packages/senpi-task/src/manager/manager-nicknames.test.ts \
			./packages/senpi-task/src/tools/task/execute-spawn.test.ts \
			./packages/senpi-task/src/tools/task/execute-batch-background.test.ts \
			./packages/senpi-task/src/tools/control/send.test.ts \
			./packages/senpi-task/src/tools/output/output.test.ts
	fi
	clean "$bun" --no-env-file "$scripts/omo-local-build-stage.mjs" "$run" "$scratch" "$desktop"
)
read -r runtime <"$run/runtime-id"
step "Packaging the Linux x64 candidate"
(
	cd "$scratch/omo"
	clean "$bun" --no-env-file run script/build-omo-binary.ts --target linux-x64 --omo-version "$omo_version" \
		--omo-ai-version "$runtime" --out-dir "$run/out" --build-info "$(<"$run/build-info.json")"
)
(cd "$run/out"; sha256sum --strict --check SHA256SUMS)
candidate="$run/out/omo-linux-x64"
home="$scratch/version-home"
mkdir "$home"
version=$(cd "$home"; clean "$candidate" --version)
printf '%s\n' "$version"
read -r digest _ <"$run/patch.sha256"
[[ "$version" == *"(v$omo_version)"* && "$version" == *"(v$engine_version+dense.${digest:0:10})"* &&
	-f "$home/.omo/binary-runtime/$runtime/omo" ]] || die "Candidate version or runtime mismatch"
step "Candidate: $candidate"
step "Run the separate dense-qa PTY gate before treating this candidate as verified."
