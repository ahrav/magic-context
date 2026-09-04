use base64::Engine as _;
use proptest::prelude::*;

fn reference(text: &[u8]) -> Result<Vec<u8>, ()> {
    base64::engine::general_purpose::STANDARD
        .decode(text)
        .map_err(|_| ())
}

fn optimized(text: &[u8]) -> Result<Vec<u8>, ()> {
    base64_simd::STANDARD.decode_to_vec(text).map_err(|_| ())
}

fn encoded_payload() -> impl Strategy<Value = Vec<u8>> {
    prop::collection::vec(any::<u8>(), 0..384).prop_map(|bytes| {
        base64::engine::general_purpose::STANDARD
            .encode(bytes)
            .into_bytes()
    })
}

fn edge_byte() -> impl Strategy<Value = u8> {
    prop_oneof![
        Just(b'='),
        Just(b'+'),
        Just(b'/'),
        Just(b'-'),
        Just(b'_'),
        Just(b'\n'),
        Just(b'\r'),
        Just(b' '),
        Just(b'A'),
        Just(b'B'),
        Just(b'Q'),
        Just(b'R'),
        Just(b'w'),
        Just(b'x'),
        Just(0u8),
        Just(0xffu8),
        any::<u8>(),
    ]
}

#[derive(Debug, Clone)]
enum Mutation {
    Replace(usize, u8),
    Insert(usize, u8),
    Delete(usize),
    Truncate(usize),
}

fn mutation() -> impl Strategy<Value = Mutation> {
    prop_oneof![
        (any::<usize>(), edge_byte()).prop_map(|(at, byte)| Mutation::Replace(at, byte)),
        (any::<usize>(), edge_byte()).prop_map(|(at, byte)| Mutation::Insert(at, byte)),
        any::<usize>().prop_map(Mutation::Delete),
        any::<usize>().prop_map(Mutation::Truncate),
    ]
}

fn apply(text: &mut Vec<u8>, mutation: &Mutation) {
    match *mutation {
        Mutation::Replace(at, byte) => {
            if !text.is_empty() {
                let at = at % text.len();
                text[at] = byte;
            }
        }
        Mutation::Insert(at, byte) => {
            let at = at % (text.len() + 1);
            text.insert(at, byte);
        }
        Mutation::Delete(at) => {
            if !text.is_empty() {
                let at = at % text.len();
                text.remove(at);
            }
        }
        Mutation::Truncate(at) => {
            let at = at % (text.len() + 1);
            text.truncate(at);
        }
    }
}

fn mutated_encoding() -> impl Strategy<Value = Vec<u8>> {
    (encoded_payload(), prop::collection::vec(mutation(), 1..=4)).prop_map(
        |(mut text, mutations)| {
            for mutation in &mutations {
                apply(&mut text, mutation);
            }
            text
        },
    )
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]
    #[test]
    fn valid_encodings_decode_to_the_same_bytes(payload in prop::collection::vec(any::<u8>(), 0..384)) {
        let text = base64::engine::general_purpose::STANDARD.encode(&payload);
        prop_assert_eq!(optimized(text.as_bytes()), Ok(payload.clone()));
        prop_assert_eq!(reference(text.as_bytes()), Ok(payload));
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(4096))]
    #[test]
    fn mutated_encodings_get_the_same_verdict(text in mutated_encoding()) {
        prop_assert_eq!(
            optimized(&text),
            reference(&text),
            "diverged on {:?}",
            String::from_utf8_lossy(&text)
        );
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(1024))]
    #[test]
    fn arbitrary_bytes_get_the_same_verdict(text in prop::collection::vec(edge_byte(), 0..64)) {
        prop_assert_eq!(
            optimized(&text),
            reference(&text),
            "diverged on {:?}",
            String::from_utf8_lossy(&text)
        );
    }
}
