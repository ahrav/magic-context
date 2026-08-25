use mc_host::frame_channel::ReceiveLease;

fn require_send<T: Send>(_: T) {}

fn main() {
    let bytes = [1u8, 2, 3];
    let lease = ReceiveLease::contiguous(&bytes);
    require_send(lease);
}
