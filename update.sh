#!/bin/bash
set -xe

function gh_repo_tags() {
  # REPO_REF="owner/repo"
  local REPO_REF="$1"
  # https://docs.github.com/en/rest/repos/repos?apiVersion=2022-11-28#list-repository-tags
  curl -sL \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/repos/$REPO_REF/tags"
}

function gh_repo_latest_tagname() {
  # REPO_REF="owner/repo"
  local REPO_REF="$1"
  gh_repo_tags "$REPO_REF" | \
  jq -r '.[].name | select(test("^[0-9]"))' | \
  sort -Vr | \
  head -1
}

function get_local_tagname() {
  # deno build.ts --tagName 1.64.0 > ubo.js
  cat 'package.json' | sed -n -E 's/.*--tagName ([0-9\.a-zA-Z]+).*/\1/p'
}

function update() {
  local NEW_TAGNAME="$1"
  cat 'package.json' | sed -E "s/(--tagName )([0-9\.a-zA-Z]+)/\1$NEW_TAGNAME/" | tee 'package.json'
  deno run build
}

function entrypoint() {
  local LOCAL_REF="$(get_local_tagname)"
  local UPSTREAM_REF="$(gh_repo_latest_tagname 'gorhill/ublock')"
  if [[ "$UPSTREAM_REF" == 'null' ]]; then
    echo "ERROR: Failed to retrieve upstream version! Run with 'set -xe' for debugging."
    exit 1
  fi
  if [[ "$(echo "$LOCAL_REF\n$UPSTREAM_REF" | sort -Vr | head -1)" != "$LOCAL_REF" ]]; then
    update "$UPSTREAM_REF"
  fi
}

entrypoint
