use mc_host::frame_channel::ReceiveLease;

fn main() {
    let bytes = [1u8, 2, 3];
    let lease = ReceiveLease::contiguous(&bytes);
    tokio::spawn(async move {
        let _ = lease.len();
    });
}
