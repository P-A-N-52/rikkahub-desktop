use core_foundation::{
    array::{CFArray, CFArrayRef},
    base::TCFType,
    string::CFString,
};

#[link(name = "CoreText", kind = "framework")]
extern "C" {
    fn CTFontManagerCopyAvailableFontFamilyNames() -> CFArrayRef;
}

pub(crate) fn families() -> Result<Vec<String>, String> {
    // CoreText returns a retained array of visible family names. The wrapper owns
    // that reference, while its CFString items remain borrowed from the array.
    let reference = unsafe { CTFontManagerCopyAvailableFontFamilyNames() };
    if reference.is_null() {
        return Err("CoreText did not return a font catalog".into());
    }
    let names: CFArray<CFString> = unsafe { TCFType::wrap_under_create_rule(reference) };
    Ok(names.iter().map(|name| name.to_string()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_catalog_contains_visible_standard_families() {
        let names = families().unwrap();
        assert!(names.iter().any(|name| name == "Arial"));
        assert!(names.iter().all(|name| !name.is_empty()));
    }
}
