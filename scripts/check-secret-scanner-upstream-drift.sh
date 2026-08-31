#!/bin/sh
set -eu

repository=${GOSSIP_REPOSITORY:-https://github.com/ahrav/gossip-rs}
pinned_commit=${GOSSIP_PINNED_COMMIT:-3d2869011138cd7812a12f893dc93635a961b0d7}

remote_head=$(git ls-remote --symref "$repository" HEAD 2>/dev/null) || {
    echo "secret-scanner-upstream: fetch-unavailable repository=$repository" >&2
    exit 20
}
default_ref=$(printf '%s\n' "$remote_head" | while read -r marker ref head; do
    if [ "$marker" = "ref:" ] && [ "$head" = "HEAD" ]; then
        printf '%s\n' "$ref"
        break
    fi
done)
if [ -z "$default_ref" ]; then
    echo "secret-scanner-upstream: missing-ref ref=HEAD" >&2
    exit 21
fi

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT HUP INT TERM
git -C "$scratch" init -q
git -C "$scratch" remote add origin "$repository"
if ! git -C "$scratch" fetch -q --no-tags --depth=1 origin "$pinned_commit"; then
    echo "secret-scanner-upstream: missing-ref ref=$pinned_commit" >&2
    exit 21
fi
git -C "$scratch" update-ref refs/heads/pinned FETCH_HEAD
if ! git -C "$scratch" fetch -q --no-tags --depth=1 origin "$default_ref"; then
    echo "secret-scanner-upstream: missing-ref ref=$default_ref" >&2
    exit 21
fi
git -C "$scratch" update-ref refs/heads/default FETCH_HEAD

check_source() {
    path=$1
    expected_blob=$2
    expected_sha=$3
    pinned_blob=$(git -C "$scratch" rev-parse "refs/heads/pinned:$path" 2>/dev/null) || {
        echo "secret-scanner-upstream: missing-ref ref=$pinned_commit path=$path" >&2
        exit 21
    }
    pinned_sha=$(git -C "$scratch" show "refs/heads/pinned:$path" | sha256sum | cut -d ' ' -f 1)
    if [ "$pinned_blob" != "$expected_blob" ] || [ "$pinned_sha" != "$expected_sha" ]; then
        echo "secret-scanner-upstream: source-inventory-mismatch path=$path" >&2
        exit 22
    fi
    default_blob=$(git -C "$scratch" rev-parse "refs/heads/default:$path" 2>/dev/null) || {
        echo "secret-scanner-upstream: source-drift path=$path change=deleted" >&2
        exit 23
    }
    default_sha=$(git -C "$scratch" show "refs/heads/default:$path" | sha256sum | cut -d ' ' -f 1)
    if [ "$default_blob" != "$expected_blob" ] || [ "$default_sha" != "$expected_sha" ]; then
        echo "secret-scanner-upstream: source-drift path=$path blob=$default_blob sha256=$default_sha" >&2
        exit 23
    fi
}

check_source crates/scanner-engine/default_rules.yaml 909e835f6d19a923aefa84484cd7fa215ffad973 2f1292b50148d38afe3ebdb7c489449d103b75b7df464e06da0d5d7c89ac2820
check_source crates/scanner-engine/src/api.rs c3820efb996f457f25dd659146ac57b0e01fd22e 164178b41d56fd2966409f411217b77688c44f6003228c088efc95a7ebcdf5a3
check_source crates/scanner-engine/src/rules/yaml.rs a9b74233ed859f4c45c2f8cd994899e7f5861bba 70d20faec76c2dfbabc2d9bc3d33de4cb424dd3fc74f8c848996f93633bfe9f5
check_source crates/scanner-engine/src/engine/helpers/entropy.rs 0fbeb6abf0df39d8c48e74a477694e404f81ffe5 79891d22c8151c6478a13a1defb607eb64d9cd213e0e076d50d7bc4dda5ed207
check_source crates/scanner-engine/src/engine/offline_validate.rs 24e38df8e365519afc4e0ea142793dc6c8635e10 e4e0a1952458531b4415a81da69c27e0bcb5bebfb33959bcd46742f0bd43a174
check_source crates/scanner-engine/src/engine/safelist.rs eeaa4e713c57d56ffff351ed3cefae2d4c27a23d a5c05922ae70dad988e8fcd7b8ecabb9e88d83e74c48b6af0b2d39f3afa67a47
check_source crates/scanner-engine/src/engine/window_validate.rs 0b8b88e0daab93cc07044b85c4f1c7d105e7d7f3 a362a1c1c3addbd937e0591032dd655c69559bd1eaff66e1fa1c861f1e715299
check_source LICENSE 00b501fa03e6a1b190c0a4a2f2ef66fd57431a3c 96afec54cd8f9e6497c91826a6f9576e7ae92c3c3dd68c4c0b170d9b996e2e2d

echo "secret-scanner-upstream: clean repository=$repository pinned=$pinned_commit default=$default_ref"
