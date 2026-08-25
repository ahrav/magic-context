#[test]
fn receive_lease_cannot_escape() {
    let cases = trybuild::TestCases::new();
    cases.compile_fail("tests/compile_fail/receive_lease_not_send.rs");
    cases.compile_fail("tests/compile_fail/receive_lease_not_static.rs");
}
