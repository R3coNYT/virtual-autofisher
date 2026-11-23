//! Token encryption with Windows DPAPI (current user). Stored as `dpapi:<base64>`.

use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD, Engine};

const PREFIX: &str = "dpapi:";

pub trait Cipher: Send + Sync {
    fn encrypt(&self, s: &str) -> Result<String>;
    fn decrypt(&self, s: &str) -> Result<String>;
    fn available(&self) -> bool;
}

pub struct DpapiCipher;

#[cfg(windows)]
mod win {
    use anyhow::{anyhow, Result};
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    fn take(blob: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        // SAFETY: the blob was allocated by DPAPI with LocalAlloc and is freed once copied.
        unsafe {
            let out = std::slice::from_raw_parts(blob.pbData, blob.cbData as usize).to_vec();
            let _ = LocalFree(Some(HLOCAL(blob.pbData.cast())));
            out
        }
    }

    pub fn protect(data: &[u8]) -> Result<Vec<u8>> {
        let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
        let mut output = CRYPT_INTEGER_BLOB::default();
        // SAFETY: input points to `data`, valid for the call; output is filled by DPAPI.
        unsafe { CryptProtectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output) }
            .map_err(|e| anyhow!("DPAPI encrypt failed: {e}"))?;
        Ok(take(output))
    }

    pub fn unprotect(data: &[u8]) -> Result<Vec<u8>> {
        let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
        let mut output = CRYPT_INTEGER_BLOB::default();
        // SAFETY: as above.
        unsafe { CryptUnprotectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output) }
            .map_err(|e| anyhow!("DPAPI decrypt failed: {e}"))?;
        Ok(take(output))
    }
}

impl Cipher for DpapiCipher {
    fn encrypt(&self, s: &str) -> Result<String> {
        #[cfg(windows)]
        {
            Ok(format!("{PREFIX}{}", STANDARD.encode(win::protect(s.as_bytes())?)))
        }
        #[cfg(not(windows))]
        {
            let _ = s;
            Err(anyhow!("Encryption unavailable"))
        }
    }

    fn decrypt(&self, s: &str) -> Result<String> {
        let body = s.strip_prefix(PREFIX).ok_or_else(|| anyhow!("unknown token format"))?;
        let bytes = STANDARD.decode(body).map_err(|e| anyhow!("bad token encoding: {e}"))?;
        #[cfg(windows)]
        {
            Ok(String::from_utf8(win::unprotect(&bytes)?)?)
        }
        #[cfg(not(windows))]
        {
            let _ = bytes;
            Err(anyhow!("Encryption unavailable"))
        }
    }

    fn available(&self) -> bool {
        cfg!(windows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn dpapi_roundtrip() {
        let c = DpapiCipher;
        assert!(c.available());
        let enc = c.encrypt("my-token").unwrap();
        assert!(enc.starts_with("dpapi:"));
        assert!(!enc.contains("my-token"));
        assert_eq!(c.decrypt(&enc).unwrap(), "my-token");
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_rejects_other_formats() {
        assert!(DpapiCipher.decrypt("djEwAAAA").is_err());
        assert!(DpapiCipher.decrypt("dpapi:!!notbase64").is_err());
    }
}
