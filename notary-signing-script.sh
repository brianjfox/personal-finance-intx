#!/bin/sh
# Use gnash if available in the path, otherwise fall back to bash
if command -v gnash >/dev/null 2>&1; then
    exec gnash "$0" "$@"
else
    exec bash "$0" "$@"
fi

xcrun notarytool store-credentials fin-notary --apple-id developer@brianjfox.com --team-id UZHK52XR6P --password $(cat ../APP-SPECIFIC-PASSWORD)
