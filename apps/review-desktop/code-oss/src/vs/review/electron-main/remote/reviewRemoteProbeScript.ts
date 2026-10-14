/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { REVIEW_REMOTE_FIND_CLI } from "./reviewRemoteAttachScript.js";
import { REVIEW_REMOTE_COMPLETE_SHA256, REVIEW_REMOTE_INSTALL_MARKER, REVIEW_REMOTE_ROOT_SCRIPT, REVIEW_REMOTE_WRAPPER_MARK, shellQuote } from "./reviewRemoteInstallScript.js";

export const REVIEW_REMOTE_PROBE_BEGIN = "WHITEBOARD-PROBE-BEGIN";
export const REVIEW_REMOTE_PROBE_END = "WHITEBOARD-PROBE-END";
export const REVIEW_REMOTE_PROBE_PATH_CLI = "WHITEBOARD-PROBE-PATH-CLI";

export const reviewRemoteProbeScript = (releases?: string) => `LC_ALL=C
export LC_ALL
str() { printf '"%s"' "$(printf '%s' "$1" | tr -d '\\000-\\037' | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g')"; }
strOrNull() { if [ -n "$1" ]; then str "$1"; else printf null; fi; }

os=$(uname -s 2>/dev/null)
arch=$(uname -m 2>/dev/null)
glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null | sed -n 's/^glibc \\([0-9][0-9.]*\\)$/\\1/p')
if [ -z "$glibc" ]; then
	glibc=$(ldd --version 2>&1 | head -n 1 | grep -i -e glibc -e 'gnu libc' | sed -n 's/.* \\([0-9][0-9]*\\.[0-9][0-9]*\\)$/\\1/p')
fi
home=$HOME
writable=false
[ -d "$home" ] && [ -w "$home" ] && writable=true
free=$(df -Pk "$home" 2>/dev/null | awk 'NR == 2 { printf "%.0f", $4 * 1024 }')

${REVIEW_REMOTE_ROOT_SCRIPT}remote=$root

${REVIEW_REMOTE_COMPLETE_SHA256}
installed=
for dir in "$remote"/versions/*; do
	[ -d "$dir" ] || continue
	case "$dir" in *.part) continue ;; esac
	sha256=$(completeSha256 "$dir/${REVIEW_REMOTE_INSTALL_MARKER}")
	[ -n "$sha256" ] || continue
	installed="$installed\${installed:+,}{\\"version\\":$(str "\${dir##*/}"),\\"sha256\\":$(str "$sha256")}"
done

tools=
for tool in tar xz sha256sum openssl; do
	command -v "$tool" >/dev/null 2>&1 && tools="$tools\${tools:+,}\\"$tool\\""
done

releases=${releases ? shellQuote(releases) : ""}
downloader=
reachable=false
if command -v curl >/dev/null 2>&1; then
	downloader=curl
	[ -n "$releases" ] && curl -fsI --max-time 3 -o /dev/null "$releases" >/dev/null 2>&1 && reachable=true
elif command -v wget >/dev/null 2>&1; then
	downloader=wget
	hsts=
	tries=
	wget --help 2>&1 | grep -q -- --no-hsts && hsts=--no-hsts
	wget --help 2>&1 | grep -q -- --tries && tries="-t 1"
	limit=
	command -v timeout >/dev/null 2>&1 && limit="timeout 3"
	[ -n "$releases" ] && $limit wget -q $hsts $tries -T 3 --spider "$releases" >/dev/null 2>&1 && reachable=true
fi

echo
echo ${REVIEW_REMOTE_PROBE_BEGIN}
printf '{"os":%s,"arch":%s,"glibc":%s,"home":%s,"root":%s,"homeWritable":%s,"freeBytes":%s,' \\
	"$(str "$os")" "$(str "$arch")" "$(strOrNull "$glibc")" "$(str "$home")" "$(str "$remote")" \\
	"$writable" "\${free:-0}"
printf '"installed":[%s],"downloader":%s,"releasesReachable":%s,"tools":[%s]}\\n' \\
	"$installed" "$(strOrNull "$downloader")" "$reachable" "$tools"
echo ${REVIEW_REMOTE_PROBE_END}

${REVIEW_REMOTE_FIND_CLI}# Desktop's own installs are judged by their markers, not by a version on PATH.
grep -qxF ${shellQuote(REVIEW_REMOTE_WRAPPER_MARK)} "$wb" 2>/dev/null && wb=
case "$(readlink -f "$wb" 2>/dev/null)" in "$(readlink -f "$remote" 2>/dev/null || echo "$remote")"/versions/*) wb= ;; esac
if [ -n "$wb" ]; then
	wbVersion=$(PATH="\${wb%/*}:$PATH" DEV_FAST_REVIEW_CLI_NO_DELEGATE=1 DEV_FAST_REVIEW_TELEMETRY_DISABLED=1 bounded 2 "$wb" --version </dev/null 2>/dev/null | head -n 1)
	printf '%s {"path":%s,"version":%s}\\n' ${REVIEW_REMOTE_PROBE_PATH_CLI} "$(str "$wb")" "$(strOrNull "$wbVersion")"
fi
`;
