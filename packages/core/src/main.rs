use std::env;
use std::ffi::OsString;
use std::process;

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() != 3 {
        eprintln!("Usage: openspec-diff-core <uri1> <uri2>  # compare two spec file paths");
        process::exit(2);
    }

    let openspec_command =
        env::var_os("OPENSPEC_DIFF_OPENSPEC_BIN").unwrap_or_else(|| OsString::from("openspec"));

    match openspec_diff_core::diff_with_openspec_command(
        &args[1],
        &args[2],
        openspec_command.as_os_str(),
    ) {
        Ok(code) => process::exit(code),
        Err(error) => {
            eprintln!("{error}");
            process::exit(2);
        }
    }
}
