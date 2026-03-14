pub fn name() -> &'static str {
    "openspec-diff core"
}

#[cfg(test)]
mod tests {
    use super::name;

    #[test]
    fn returns_the_core_package_name() {
        assert_eq!(name(), "openspec-diff core");
    }
}
