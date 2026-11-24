#!/usr/bin/env bash
# Build this branch's tool-density patch with the pinned local OmO recipe.
# Or verify a trusted prebuilt binary with --binary, without a source checkout or compile.
# Prebuilt validation requires the local density and thinking smoke drivers.
# Build-only by default. --activate updates ~/.local/bin/omo for future launches.
# Failures stop the run. Read the printed build log; fix the cause and rerun.
set -euo pipefail

die() { printf '%s\n' "$*" >&2; exit 1; }
usage='Usage: bash scripts/omo-local-build.sh [--preflight | --activate] [--nicknames] | [--activate] --binary PATH [--sha256 HASH]'
activate=false
preflight=false
nicknames=false
binary=
expected=
while (( $# )); do
	case "$1" in
		-h|--help)
			printf '%s\n%s\n%s\n' "$usage" 'Source builds produce a candidate by default; --preflight only checks the source patch.' 'With --activate, build if needed, then verify and atomically install the candidate.'
			exit 0 ;;
		--activate) [[ "$activate" == false ]] || die "Duplicate --activate"; activate=true ;;
		--preflight) [[ "$preflight" == false ]] || die "Duplicate --preflight"; preflight=true ;;
		--nicknames) [[ "$nicknames" == false ]] || die "Duplicate --nicknames"; nicknames=true ;;
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
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
if [[ -z "$binary" ]]; then
	source_args=()
	if "$preflight"; then
		[[ "$activate" == false ]] || die "--preflight cannot be combined with --activate"
		source_args+=(--preflight)
	fi
	if "$nicknames"; then
		source_args+=(--nicknames)
	fi
	if ! "$activate"; then
		exec bash "$root/scripts/omo-local-build-candidate.sh" "${source_args[@]}"
	fi
	build_output=$(bash "$root/scripts/omo-local-build-candidate.sh" "${source_args[@]}" | tee /dev/stderr)
	while IFS= read -r line; do
		[[ "$line" != "Candidate: "* ]] || binary=${line#Candidate: }
	done <<<"$build_output"
	[[ "$binary" == /* ]] || die "Source build did not report its candidate path"
	preflight=false
	nicknames=false
fi
[[ "$preflight" == false && "$nicknames" == false ]] || die "--binary cannot be combined with source build options"
[[ "$(uname -sm)" == "Linux x86_64" && "$(bun --version)" == 1.4.4 ]] ||
	die "Use Linux x64 and standalone Bun 1.4.4 on PATH"

export GIT_MASTER=1 CI=1
state=${OMO_SENPI_BUILD_HOME:-"$HOME/.local/share/omo-local-builds/senpi"}
launcher="$HOME/.local/bin/omo"
omo_sha=5cb1e0154b464e75f06cef7e8dec588f2d6fc401
engine_sha=2c28cd8c166542e116e7a1f51412d419fb6f1b97
omo_version=5.1.78
engine_version=2026.11.18-2
transcript="$root/local-ignore/qa-evidence/20261123-dense-card-polish/dense-card-qa.mjs"
thinking="$root/local-ignore/omo-live-thinking-smoke.mjs"

for input in "$transcript" "$thinking"; do
	[[ -f "$input" ]] || die "Missing local build input: $input"
done
umask 077
mkdir -p -- "$state/runs"
run=$(mktemp -d "$state/runs/live.XXXXXXXX")
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
runtime=$observed_runtime
printf 'Runtime: %s\n' "$runtime"
step "Running the transcript and thinking terminal smokes"
(cd "$root"; bun --no-install "$transcript" --run --candidate "$candidate" --activation-smoke; bun --no-install "$thinking" "$candidate")
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
