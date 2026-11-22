#!/usr/bin/env bash
# Build this branch's tool-density patch with the pinned local OmO recipe.
# Or verify a trusted prebuilt binary with --binary, without a source checkout or compile.
# Both modes require the local-ignore/omo-live-{transcript,thinking}-smoke.mjs drivers.
# Build-only by default. --activate updates ~/.local/bin/omo for future launches.
# Failures stop the run. Read the printed build log; fix the cause and rerun.
set -euo pipefail

die() { printf '%s\n' "$*" >&2; exit 1; }
usage='Usage: bash scripts/omo-local-build.sh [--activate] [--binary PATH [--sha256 HASH]]'
activate=false
binary=
expected=
while (( $# )); do
	case "$1" in
		-h|--help)
			printf '%s\n%s\n' "$usage" 'With --binary, validate only unless --activate is given. Use a trusted --sha256 or adjacent SHA256SUMS.'
			exit 0 ;;
		--activate) [[ "$activate" == false ]] || die "Duplicate --activate"; activate=true ;;
		--binary)
			[[ -z "$binary" && -n "${2:-}" && "$2" != --* ]] || die "Expected one --binary PATH"
			binary=$2
			shift ;;
		--sha256)
			[[ -z "$expected" && "${2:-}" =~ ^[[:xdigit:]]{64}$ ]] || die "Expected one 64-digit --sha256 HASH"
			expected=${2,,}
			shift ;;
		*) die "$usage" ;;
	esac
	shift
done
[[ -z "$expected" || -n "$binary" ]] || die "--sha256 requires --binary"
[[ "$(uname -sm)" == "Linux x86_64" && "$(bun --version)" == 1.4.4 ]] ||
	die "Use Linux x64 and standalone Bun 1.4.4 on PATH"

export GIT_MASTER=1 CI=1
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
recipe="$root/local-ignore/omo-density-build"
launcher="$HOME/.local/bin/omo"
desktop="$HOME/.omo/binary-runtime/5.1.78/native/prebuilds/linux-x64/senpi-desktop-engine"
base=c51802622c99f693cdd28b57d53b9217dafbcab7
omo_sha=5cb1e0154b464e75f06cef7e8dec588f2d6fc401
engine_sha=2c28cd8c166542e116e7a1f51412d419fb6f1b97
omo_version=5.1.78
engine_version=2026.11.18-2
transcript="$root/local-ignore/omo-live-transcript-smoke.mjs"
thinking="$root/local-ignore/omo-live-thinking-smoke.mjs"

for input in "$transcript" "$thinking"; do
	[[ -f "$input" ]] || die "Missing local build input: $input"
done
if [[ -z "$binary" ]]; then
	for input in "$recipe/stage-density.mjs" "$desktop"; do
		[[ -f "$input" ]] || die "Missing local build input: $input"
	done
fi
umask 077
mkdir -p -- "$recipe"
run=$(mktemp -d "$recipe/live.XXXXXXXX")
scratch=$(mktemp -d /tmp/omo-live.XXXXXXXX)
swap=
printf 'Build log: %s/build.log\n' "$run"
exec 3>&1
exec >"$run/build.log" 2>&1
cleanup() {
	local status=$?
	[[ -z "$swap" ]] || rm -rf -- "$swap"
	rm -rf -- "$scratch"
	if (( status != 0 )); then tail -n 15 "$run/build.log" >&3; fi
	exit "$status"
}
trap cleanup EXIT
printf 'OmO %s %s\nSenpi %s %s\n' "$omo_version" "$omo_sha" "$engine_version" "$engine_sha"
step() { printf '%s\n' "$1"; printf '%s\n' "$1" >&3; }

if "$activate"; then
	[[ "$(command -v omo)" == "$launcher" && -f "$launcher" && ! -L "$launcher" && -O "$launcher" ]] ||
		die "PATH must select the regular, user-owned launcher $launcher"
	lock="${launcher%/*}/.omo-local-build.lock"
	[[ ! -L "$lock" && ( ! -e "$lock" || ( -f "$lock" && -O "$lock" ) ) ]] || die "Unsafe activation lock"
	exec 9>>"$lock"
	flock -n 9 || die "Another OmO activation is in progress"
	previous=$(sha256sum "$launcher")
	identity=$(stat -c '%d:%i:%u:%g:%a' "$launcher")
	printf 'Current launcher: %s\n' "$previous"
fi

verify_hash() { printf '%s  %s\n' "$1" "$2" | sha256sum --check --status; }
if [[ -n "$binary" ]]; then
	[[ -f "$binary" && ! -L "$binary" && -x "$binary" ]] || die "Not a regular executable: $binary"
	if [[ -z "$expected" ]]; then
		manifest="$(dirname -- "$binary")/SHA256SUMS"
		[[ -f "$manifest" && ! -L "$manifest" ]] || die "Supply --sha256 or an adjacent SHA256SUMS"
		# Read only the requested file's entry; do not follow other paths from the manifest.
		while IFS= read -r line || [[ -n "$line" ]]; do
			if [[ "${line:64:2}" == "  " || "${line:64:2}" == ' *' ]] &&
				[[ "${line:66}" == "${binary##*/}" && "${line:0:64}" =~ ^[[:xdigit:]]{64}$ ]]; then
				[[ -z "$expected" ]] || die "Duplicate checksum for ${binary##*/}"
				expected=${line:0:64}
				expected=${expected,,}
			fi
		done <"$manifest"
		[[ -n "$expected" ]] || die "No checksum for ${binary##*/} in $manifest"
	fi
	printf 'Prebuilt input: %s\n' "$binary"
	candidate="$scratch/omo-linux-x64"
	cp -- "$binary" "$candidate"
	chmod 500 "$candidate"
	verify_hash "$expected" "$candidate" || die "Prebuilt checksum mismatch"
	step "Using a verified prebuilt binary; skipping source checks and compilation"
	runtime=
else
verify_hash 1cfcd93569e3418124076aee70a6dc111b18a3fa4feca3c60f2dab65b3e81b39 "$desktop"
git -C "$root" merge-base --is-ancestor "$base" HEAD
git -C "$root" diff --name-only -z --no-renames "$base" -- packages >"$scratch/paths"
git -C "$root" ls-files --others --exclude-standard -z -- packages >"$scratch/untracked"
while IFS= read -r -d '' file; do
	case "$file" in
		packages/coding-agent/src/*.ts|packages/tui/src/*.ts)
			[[ -f "$root/$file" && ! -L "$root/$file" ]] || die "Unsupported deleted or linked runtime file: $file"
			;;
		packages/coding-agent/test/*|packages/coding-agent/docs/*|packages/tui/test/*) ;;
		*) die "Outside this recipe's supported patch scope: $file" ;;
	esac
done < <(cat "$scratch/paths" "$scratch/untracked")
patch="$run/senpi.patch"
git -C "$root" diff --binary --no-renames "$base" -- packages >"$patch"
while IFS= read -r -d '' file; do
	[[ -f "$root/$file" && ! -L "$root/$file" ]] || die "Not a regular file: $file"
	status=0
	git -C "$root" diff --no-index --binary -- /dev/null "$file" >>"$patch" || status=$?
	[[ "$status" == 1 ]] || die "Unable to export new file: $file"
done <"$scratch/untracked"
[[ -s "$patch" ]] || die "No Senpi patch to build"
printf 'Senpi patch: '
sha256sum "$patch"

checkout() {
	git clone --quiet --no-hardlinks -- "$1" "$3"
	git -C "$3" checkout --quiet --detach "$2"
	[[ "$(git -C "$3" rev-parse HEAD)" == "$2" ]] || die "Unexpected checkout: $3"
}
apply_patch_to() {
	git -C "$1" apply --check "$patch"
	git -C "$1" apply "$patch"
}
checkout "$root" "$base" "$scratch/source"
apply_patch_to "$scratch/source"
step "Checking the Senpi patch in an isolated source tree"
(
	cd "$scratch/source"
	bun install --frozen-lockfile --ignore-scripts
	bun run check
	bun run --cwd packages/coding-agent test --reporter=default \
		test/suite/assistant-density-cards.test.ts test/suite/notice-density-cards.test.ts \
		test/suite/tool-display-density.test.ts
)

checkout "$recipe/engine" "$engine_sha" "$scratch/engine"
apply_patch_to "$scratch/engine"
step "Building the pinned Senpi engine"
(cd "$scratch/engine"; bun install --frozen-lockfile --ignore-scripts; bun run build)
checkout "$recipe/omo" "$omo_sha" "$scratch/omo"
git -C "$recipe/omo" diff --binary "$omo_sha" -- script/build-omo-binary.ts >"$scratch/packager.patch"
verify_hash 4ca5de7880cb40ddb8b51aaa28e8c1557e56556b971cf54c661461b9b43d70bb "$scratch/packager.patch" ||
	die "The retained OmO packager patch differs from the reviewed canvas adjustment"
(
	cd "$scratch/omo"
	node -e '
		const pkg = require("./packages/omo-native/package.json");
		if (pkg.version !== process.argv[1] || pkg.dependencies["@code-yeongyu/senpi"] !== process.argv[2]) {
			throw Error("OmO package pins differ from the local build recipe");
		}
	' "$omo_version" "$engine_version"
)
git -C "$scratch/omo" apply --check "$scratch/packager.patch"
git -C "$scratch/omo" apply "$scratch/packager.patch"
(cd "$scratch/omo"; bun install --frozen-lockfile --ignore-scripts)
cp -- "$recipe/stage-density.mjs" "$scratch/stage-density.mjs"
(cd "$root"; bun "$scratch/stage-density.mjs" "$run" "$scratch/engine" "$patch")
read -r runtime <"$run/runtime-id"
# A fresh ID prevents a rebuilt executable from replacing files used by running sessions.
runtime="$runtime.$(printf '%s' "${run##*.}" | sha256sum | cut -c1-10)"
build_info=$(<"$run/build-info.json")
step "Packaging OmO"
(
	cd "$scratch/omo"
	bun run script/build-omo-binary.ts --target linux-x64 --omo-version "$omo_version" \
		--omo-ai-version "$runtime" --out-dir "$run/out" --build-info "$build_info"
)
(cd "$run/out"; sha256sum --strict --check SHA256SUMS)
candidate="$run/out/omo-linux-x64"
fi
candidate_sum=$(sha256sum "$candidate")
printf 'Candidate: %s\n' "$candidate_sum"

home="$scratch/version-home"
mkdir -m 700 "$home"
isolated_version() {
	(cd "$home"; timeout 30s env -i "PATH=$PATH" "HOME=$home" "USERPROFILE=$home" PI_OFFLINE=1 \
		OMO_DISABLE_TELEMETRY=1 SENPI_OMO_LOCAL_UPDATE=0 "$1" --version)
}
old_runtime=
already_installed=false
if "$activate" && [[ "${previous%% *}" == "${candidate_sum%% *}" ]]; then
	already_installed=true
elif "$activate"; then
	isolated_version "$launcher"
	old_runtimes=("$home"/.omo/binary-runtime/*/omo)
	[[ ${#old_runtimes[@]} == 1 && -x "${old_runtimes[0]}" ]] || die "Expected one provisioned predecessor runtime"
	old_runtime=${old_runtimes[0]}
	old_inode=$(stat -c '%d:%i' "$old_runtime")
fi
version=$(isolated_version "$candidate")
printf '%s\n' "$version"
[[ "$version" == *"omo   $omo_sha "*"(v$omo_version)"* && "$version" == *"senpi $engine_sha "* &&
	( "$version" == *"(v$engine_version+density."* || "$version" == *"(v$engine_version+dense."* ) ]] ||
	die "Candidate version does not match the pinned OmO and Senpi releases"
if [[ -n "$old_runtime" ]]; then
	[[ -x "$old_runtime" && "$(stat -c '%d:%i' "$old_runtime")" == "$old_inode" ]] ||
		die "Candidate replaced the predecessor runtime in the isolated probe"
fi
new_runtimes=()
for executable in "$home"/.omo/binary-runtime/*/omo; do
	[[ "$executable" != "$old_runtime" && -x "$executable" ]] && new_runtimes+=("$executable")
done
[[ ${#new_runtimes[@]} == 1 ]] || die "Expected one distinct candidate runtime"
runtime_dir=${new_runtimes[0]%/omo}
observed_runtime=${runtime_dir##*/}
[[ -z "$runtime" || "$runtime" == "$observed_runtime" ]] || die "Unexpected candidate runtime"
runtime=$observed_runtime
printf 'Runtime: %s\n' "$runtime"
step "Running the transcript and thinking terminal smokes"
(cd "$root"; bun --no-install "$transcript" "$candidate"; bun --no-install "$thinking" "$candidate")
if ! "$activate"; then
	step "Validation passed: ${binary:-$candidate}"
	exit 0
fi
if "$already_installed"; then
	[[ ! -L "$launcher" && "$(stat -c '%d:%i:%u:%g:%a' "$launcher")" == "$identity" ]] ||
		die "Current launcher changed during validation"
	verify_hash "${candidate_sum%% *}" "$launcher" || die "Current launcher changed during validation"
	step "Already installed: $launcher"
	exit 0
fi

[[ ! -e "$HOME/.omo/binary-runtime/$runtime" && ! -L "$HOME/.omo/binary-runtime/$runtime" ]] ||
	die "Candidate runtime already exists in the live home"

# Stage on the same filesystem. Never write into an executable used by a live process.
swap=$(mktemp -d "${launcher%/*}/.omo-swap.XXXXXXXX")
backup="$run/omo.previous"
cp -p -- "$launcher" "$backup"
verify_hash "${previous%% *}" "$backup"
cp -p -- "$candidate" "$swap/omo"
chgrp --reference="$launcher" "$swap/omo"
chmod --reference="$launcher" "$swap/omo"
verify_hash "${candidate_sum%% *}" "$swap/omo"
[[ ! -L "$launcher" && "$(stat -c '%d:%i:%u:%g:%a' "$launcher")" == "$identity" ]] ||
	die "Launcher changed during the build; left it untouched"
verify_hash "${previous%% *}" "$launcher"
printf 'Backup: %s (%s)\n' "$backup" "${previous%% *}"
mv -T -- "$swap/omo" "$launcher"
verify_hash "${candidate_sum%% *}" "$launcher"
step "Activated: $launcher"
step "Rollback: $backup"
