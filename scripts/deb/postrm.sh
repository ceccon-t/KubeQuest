#!/bin/bash
# Mirrors electron-builder's default postrm (replaced wholesale alongside
# postinst.sh — see that file's header).

# Delete the link to the binary
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove 'kubequest' '/usr/bin/kubequest'
else
    rm -f '/usr/bin/kubequest'
fi
