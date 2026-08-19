use aes::Aes128;
use aes::cipher::{BlockEncrypt, KeyInit, generic_array::GenericArray};
use md5::Digest;

pub fn md5(data: &[u8]) -> [u8; 16] {
    let d = md5::Md5::digest(data);
    let mut out = [0u8; 16];
    out.copy_from_slice(&d);
    out
}

pub fn encrypt_password(plain: &str, username: &str) -> [u8; 16] {
    let key = md5([b"mw", username.as_bytes()].concat().as_slice());
    let mut pt = [0u8; 16];
    let b = plain.as_bytes();
    pt[..b.len().min(16)].copy_from_slice(&b[..b.len().min(16)]);
    let c = Aes128::new(GenericArray::from_slice(&key));
    let mut blk = GenericArray::clone_from_slice(&pt);
    c.encrypt_block(&mut blk);
    let mut out = [0u8; 16];
    out.copy_from_slice(&blk);
    out
}

pub fn session_key(username: &str, password: &str) -> [u8; 16] {
    md5([username.as_bytes(), password.as_bytes()]
        .concat()
        .as_slice())
}

pub fn xor(data: &mut [u8], key: &[u8]) {
    if key.is_empty() {
        return;
    }
    for i in 0..data.len() {
        data[i] ^= key[i % key.len()];
    }
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}
