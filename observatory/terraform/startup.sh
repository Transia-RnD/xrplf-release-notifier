#!/usr/bin/env bash
# One-time VM bootstrap: toolchain to build the Rust monitors + a swapfile so a
# 2GB box can link them. Code + systemd units are pushed later by ../deploy.sh.
set -euxo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y build-essential pkg-config perl make git curl rsync

# 2GB swap — cargo linking the crawler (tokio + vendored openssl) can spike.
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi

# Rust toolchain for the deploy user.
id -u observatory >/dev/null 2>&1 || useradd -m -s /bin/bash observatory
sudo -u observatory bash -lc 'command -v cargo >/dev/null || (curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y)'

install -d -o observatory -g observatory /var/lib/observatory
touch /etc/observatory.env && chmod 600 /etc/observatory.env
