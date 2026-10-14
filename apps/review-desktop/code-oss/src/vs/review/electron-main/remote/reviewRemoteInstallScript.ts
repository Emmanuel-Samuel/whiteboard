/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { REVIEW_REMOTE_INSTALL_LOCK, REVIEW_REMOTE_LOCK_STALE_SECONDS, REVIEW_REMOTE_VERSION, REVIEW_REMOTE_WRAPPER_MARK } from "../../common/reviewProtocol.js";

export { REVIEW_REMOTE_LOCK_STALE_SECONDS, REVIEW_REMOTE_VERSION, REVIEW_REMOTE_WRAPPER_MARK };

export const REVIEW_REMOTE_INSTALL_SAY = "WHITEBOARD-INSTALL";
export const REVIEW_REMOTE_INSTALL_MARKER = ".whiteboard-install.json";

export function shellQuote(value: string, lines = false): string {
	if ((lines ? /[\x00-\x09\x0b-\x1f\x7f-\x9f]/ : /[\x00-\x1f\x7f-\x9f]/).test(value)) {
		throw new Error(`${JSON.stringify(value)} holds a control character.`);
	}
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface ReviewRemoteInstallContext {
	readonly home: string;
	readonly root: string;
	readonly token: string;
}

export const REVIEW_REMOTE_ROOT_SCRIPT = `base=$(printf '%s' "\${DEV_REVIEW_HOME-}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
root=
case "$base" in
'') root=$HOME/.dev/whiteboard-remote ;;
*//*|*/./*|*/../*|*/.|*/..|*/./|*/../) ;;
/*) root=\${base%/}/whiteboard-remote ;;
esac
[ "$(printf '%s' "\${DEV_REVIEW_HOME-}" | tr -d '\\001-\\037\\177')" = "\${DEV_REVIEW_HOME-}" ] || root=
`;

export const reviewRemoteVersionDir = (root: string, version: string) => `${root}/versions/${version}`;
const reviewRemoteWrapperPath = (home: string) => `${home}/.local/bin/whiteboard`;

const versionPart = (context: ReviewRemoteInstallContext, version: string) => `${reviewRemoteVersionDir(context.root, version)}.${context.token}.part`;

function prelude(context: ReviewRemoteInstallContext): string {
	if (!/^[0-9a-f]{8,64}$/.test(context.token)) throw new Error("The install token is not hex.");
	return `LC_ALL=C
export LC_ALL
umask 022
trap '' PIPE
exec 3>&1
root=${shellQuote(context.root)}
lock="$root/${REVIEW_REMOTE_INSTALL_LOCK}"
token=${context.token}
say() { printf '\\n%s %s\\n' ${REVIEW_REMOTE_INSTALL_SAY} "$*" >&3; }
fail() { say FAIL "$*"; exit 3; }
# A rename, so a reader never sees "started" half written.
stamp() { date +%s > "$lock/started.$token" && mv -f "$lock/started.$token" "$lock/started"; }
own() {
	[ "$(cat "$lock/token" 2>/dev/null)" = "$token" ] || fail this install no longer holds the install lock
	stamp
}
guard() {
	if command -v setsid >/dev/null 2>&1; then setsid "$@" & else "$@" & fi
	pid=$!
	while kill -0 "$pid" 2>/dev/null; do
		printf '.\\n' >&3 2>/dev/null || { kill -TERM -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null; exit 3; }
		[ "$(cat "$lock/token" 2>/dev/null)" = "$token" ] && stamp
		sleep 1
	done
	wait "$pid"
}
`;
}

export function lockScript(context: ReviewRemoteInstallContext, owner: string, staleSeconds = REVIEW_REMOTE_LOCK_STALE_SECONDS): string {
	const staleMinutes = Math.ceil(staleSeconds / 60);
	return `${prelude(context)}mkdir -p "$root" || fail cannot create "$root"
take() {
	mkdir "$lock" 2>/dev/null || return 1
	printf '%s\\n' "$token" > "$lock/token"
	printf '%s\\n' ${shellQuote(owner)} > "$lock/owner"
	stamp
	say LOCKED
	exit 0
}
take
# The token first: a takeover completed between the two reads leaves "started" fresh.
held=$(cat "$lock/token" 2>/dev/null)
started=$(cat "$lock/started" 2>/dev/null)
case "$started" in
''|*[!0-9]*)
	# Never written (a holder that died right after mkdir): by the directory's age. Unreadable: fresh.
	if [ ! -e "$lock/started" ] && [ -n "$(find "$lock" -prune -mmin +${staleMinutes} 2>/dev/null)" ]; then started=0; else started=$(date +%s); fi ;;
esac
if [ $(( $(date +%s) - started )) -ge ${staleSeconds} ]; then
	stale="$lock.$token.stale"
	if mv "$lock" "$stale" 2>/dev/null; then
		# Another install may have taken it over first: give that one back.
		if [ "$(cat "$stale/token" 2>/dev/null)" = "$held" ] || [ -e "$lock" ]; then rm -rf "$stale"; else mv "$stale" "$lock"; fi
	fi
	take
fi
say BUSY "$(cat "$lock/owner" 2>/dev/null)"
`;
}

export function releaseScript(context: ReviewRemoteInstallContext): string {
	return `${prelude(context)}if [ "$(cat "$lock/token" 2>/dev/null)" = "$token" ] && mv "$lock" "$lock.$token.done" 2>/dev/null; then
	rm -rf "$lock.$token.done"
fi
say RELEASED
`;
}

export function prepareScript(context: ReviewRemoteInstallContext, input: { version: string; sha256: string }): string {
	return `${prelude(context)}own
rm -rf "$root"/versions/*.part "$lock".*.stale "$lock".*.done
mkdir -p "$root/versions" || fail cannot create "$root/versions"
${markerCheck(context, input)}
p=${shellQuote(versionPart(context, input.version))}
if [ -n "$complete" ]; then
	say COMPLETE
	say MARKER "$(cat "$m")"
elif [ -e "$v" ]; then
	mv "$v" "$p" && rm -rf "$p" || fail cannot remove "$v"
fi
for dir in "$root"/versions/*; do
	[ -n "$(completeSha256 "$dir/${REVIEW_REMOTE_INSTALL_MARKER}")" ] && say HAVE "\${dir##*/}" && continue
	# A version whose removal was cut short (its marker went first).
	case "\${dir##*/}" in [0-9]*.[0-9]*.[0-9]*) rm -rf "$dir" ;; esac
done
[ -n "$complete" ] || mkdir "$p" || fail cannot create "$p"
say PREPARED
`;
}

export const REVIEW_REMOTE_COMPLETE_SHA256 = `completeSha256() {
	cs=$(sed -n 's/.*"sha256":"\\([^"][^"]*\\)".*/\\1/p' "$1" 2>/dev/null)
	cn=$(sed -n 's/.*"node":"\\([^"]*\\)".*/\\1/p' "$1" 2>/dev/null)
	cc=$(sed -n 's/.*"cli":"\\([^"]*\\)".*/\\1/p' "$1" 2>/dev/null)
	[ -n "$cs" ] && [ -x "$cn" ] && [ -f "$cc" ] && printf '%s' "$cs"
}`;

function markerCheck(context: ReviewRemoteInstallContext, input: { version: string; sha256: string }): string {
	return `v=${shellQuote(reviewRemoteVersionDir(context.root, input.version))}
m="$v/${REVIEW_REMOTE_INSTALL_MARKER}"
${REVIEW_REMOTE_COMPLETE_SHA256}
complete=
[ -f "$m" ] && [ "$(completeSha256 "$m")" = ${shellQuote(input.sha256)} ] && complete=1`;
}

export function completeScript(context: ReviewRemoteInstallContext, input: { version: string; sha256: string }): string {
	return `${prelude(context)}${markerCheck(context, input)}
[ -n "$complete" ] || exit 0
say COMPLETE
say MARKER "$(cat "$m")"
`;
}

const packageTarball = (context: ReviewRemoteInstallContext, version: string) => `${versionPart(context, version)}/whiteboard-remote.tar.xz`;

const DOWNLOAD = {
	curl: `guard curl -fsSL --connect-timeout 20 --max-time 900 -o "$f" "$url"`,
	wget: `hsts=
wget --help 2>&1 | grep -q -- --no-hsts && hsts=--no-hsts
limit=
command -v timeout >/dev/null 2>&1 && limit="timeout 900"
guard $limit wget -q $hsts -t 2 -T 30 -O "$f" "$url"`,
};

export function unpackScript(
	context: ReviewRemoteInstallContext,
	input: { version: string; sha256: string; url: string; downloader: "curl" | "wget" },
): string {
	if (!/^[0-9a-f]{64}$/.test(input.sha256)) throw new Error("The tarball checksum is not a sha256.");
	return `${prelude(context)}own
p=${shellQuote(versionPart(context, input.version))}
f=${shellQuote(packageTarball(context, input.version))}
url=${shellQuote(input.url)}
${DOWNLOAD[input.downloader]} || { s=$?; rm -rf "$p"; fail cannot download "$url": ${input.downloader} exited with "$s"; }
sum=$(sha256sum "$f" 2>/dev/null || openssl dgst -sha256 -r "$f" 2>/dev/null)
sum=\${sum%% *}
[ "$sum" = ${input.sha256} ] || { rm -rf "$p"; say MISMATCH "$sum"; exit 3; }
guard tar -xJf "$f" -C "$p" --strip-components=1 || { rm -rf "$p"; fail cannot unpack the tarball; }
rm -f "$f"
[ -x "$p/bin/node" ] && [ -f "$p/dist/cli.js" ] && [ -x "$p/whiteboard" ] || { rm -rf "$p"; fail the tarball holds no whiteboard; }
out=$(DEV_FAST_REVIEW_CLI_NO_DELEGATE=1 DEV_FAST_REVIEW_TELEMETRY_DISABLED=1 "$p/bin/node" "$p/dist/cli.js" version --json </dev/null 2>/dev/null | tail -n 1)
say VERSION "$out"
say UNPACKED
`;
}

export function finishScript(
	context: ReviewRemoteInstallContext,
	input: { version: string; marker: string; wrapper?: string },
): string {
	const wrapper = input.wrapper
		? `w=${shellQuote(reviewRemoteWrapperPath(context.home))}
if { [ ! -e "$w" ] && [ ! -L "$w" ]; } || { [ -f "$w" ] && [ ! -L "$w" ] && grep -qxF ${shellQuote(REVIEW_REMOTE_WRAPPER_MARK)} "$w"; }; then
	if mkdir -p "\${w%/*}" && printf '%s' ${shellQuote(input.wrapper, true)} > "$w.$token.part" && chmod 755 "$w.$token.part" && mv -f "$w.$token.part" "$w"; then
		say WRAPPER written
	else
		rm -f "$w.$token.part"
		say WRAPPER failed
	fi
else
	say WRAPPER foreign
fi
`
		: "";
	return `${prelude(context)}own
p=${shellQuote(versionPart(context, input.version))}
v=${shellQuote(reviewRemoteVersionDir(context.root, input.version))}
printf '%s\\n' ${shellQuote(input.marker)} > "$p/${REVIEW_REMOTE_INSTALL_MARKER}" || fail cannot write the marker
[ -e "$v" ] && { rm -rf "$p"; fail "$v" appeared during the install; }
mv "$p" "$v" || fail cannot move the version into place
say COMPLETE
${wrapper}rm -rf "$root"/versions/*.part
say FINISHED
`;
}

export function cleanupScript(context: ReviewRemoteInstallContext, input: { candidates: readonly string[]; room: number }): string {
	const names = input.candidates.map((name) => shellQuote(name)).join(" ");
	return `${prelude(context)}own
# Read once so a grep below never finds itself; launchers run the CLI by absolute path.
if [ -d /proc/self ]; then
	procs=$(for f in /proc/[0-9]*/cmdline; do tr '\\000' ' ' < "$f" 2>/dev/null; echo; done)
else
	procs=$(ps -eo args= 2>/dev/null)
fi
running() { printf '%s\\n' "$procs" | grep -qF -- "$root/versions/$1/"; }
kept=0
for v in ${names}; do running "$v" && kept=$((kept + 1)); done
for v in ${names}; do
	if running "$v"; then say IN-USE "$v"; continue; fi
	if [ "$kept" -lt ${input.room} ]; then kept=$((kept + 1)); continue; fi
	d="$root/versions/$v"
	[ -f "$d/${REVIEW_REMOTE_INSTALL_MARKER}" ] || continue
	rm -f "$d/${REVIEW_REMOTE_INSTALL_MARKER}" && rm -rf "$d" && say REMOVED "$v"
done
say CLEANED
`;
}
