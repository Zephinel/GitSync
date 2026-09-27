use crate::commands::AppState;
use crate::repo_git_lock::acquire_read as acquire_repo_git_read_guard;
use serde::Serialize;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tauri::State;
use tokio::process::Command;

const GIT_IMAGE_TIMEOUT_MS: u64 = crate::git_timeouts::IMAGE;
const IMAGE_SOURCE_MAX_BYTES: u64 = 24 * 1024 * 1024;
const SUPPORTED_FORMATS: &str = "PNG、APNG、JPEG、GIF、WebP、AVIF、SVG、BMP、ICO、CUR；并由系统 WebView 尝试 TIFF、HEIC/HEIF、JPEG XL、JPEG 2000、ICNS、TGA、DDS、QOI、PNM/PAM、HDR、OpenEXR、PSD、KTX/KTX2、WBMP、farbfeld";
const BASE64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

#[derive(Debug, Serialize, Clone)]
pub struct RepoImagePreviewSide {
    pub available: bool,
    pub path: String,
    pub source_label: String,
    pub mime_type: String,
    pub data_url: String,
    pub byte_size: u64,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub original_format: String,
    pub preview_format: String,
    pub converted: bool,
    pub is_too_large: bool,
    pub message: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct RepoImageDiffPreview {
    pub before: RepoImagePreviewSide,
    pub after: RepoImagePreviewSide,
    pub has_visual_diff: bool,
    pub supported_formats: String,
}

#[derive(Debug)]
enum ImageSource {
    Missing,
    TooLarge(u64),
    Bytes(Vec<u8>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ImageDescriptor {
    mime_type: &'static str,
    label: &'static str,
    is_svg: bool,
}

fn empty_side(path: &str, source_label: &str, message: impl Into<String>) -> RepoImagePreviewSide {
    RepoImagePreviewSide {
        available: false,
        path: path.to_string(),
        source_label: source_label.to_string(),
        mime_type: String::new(),
        data_url: String::new(),
        byte_size: 0,
        width: None,
        height: None,
        original_format: String::new(),
        preview_format: String::new(),
        converted: false,
        is_too_large: false,
        message: message.into(),
    }
}

fn too_large_side(path: &str, source_label: &str, byte_size: u64) -> RepoImagePreviewSide {
    RepoImagePreviewSide {
        byte_size,
        is_too_large: true,
        ..empty_side(
            path,
            source_label,
            format!(
                "图片大小为 {:.1} MB，超过 {:.0} MB 的预览上限。",
                byte_size as f64 / 1024.0 / 1024.0,
                IMAGE_SOURCE_MAX_BYTES as f64 / 1024.0 / 1024.0
            ),
        )
    }
}

fn normalize_relative_path(value: &str) -> Result<String, String> {
    let normalized = value.trim().replace('\\', "/");
    if normalized.is_empty() {
        return Err("图片路径不能为空".to_string());
    }
    if normalized.starts_with('/')
        || normalized.starts_with("//")
        || normalized
            .as_bytes()
            .get(1)
            .is_some_and(|value| *value == b':')
    {
        return Err(format!("图片路径不安全: {}", normalized));
    }
    for component in Path::new(&normalized).components() {
        if matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        ) {
            return Err(format!("图片路径不安全: {}", normalized));
        }
    }
    Ok(normalized)
}

fn ensure_repo_path(path: &str) -> Result<PathBuf, String> {
    let normalized = path.trim();
    if normalized.is_empty() {
        return Err("仓库路径不能为空".to_string());
    }
    let repo_path = PathBuf::from(normalized);
    if !repo_path.is_dir() {
        return Err(format!("仓库目录不存在: {}", normalized));
    }
    Ok(repo_path)
}

fn new_git_command(repo_path: &str, args: &[&str]) -> Command {
    let mut command = crate::git_command::new_read_only_async_command(repo_path, args);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    command
}

async fn run_git_bytes(repo_path: &str, args: &[&str]) -> Result<Vec<u8>, String> {
    let mut command = new_git_command(repo_path, args);
    let output = tokio::time::timeout(
        Duration::from_millis(GIT_IMAGE_TIMEOUT_MS),
        command.output(),
    )
    .await
    .map_err(|_| format!("Git 命令执行超时: git {}", args.join(" ")))?
    .map_err(|error| format!("无法执行 Git 命令: {}", error))?;

    if output.status.success() {
        Ok(output.stdout)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("Git 命令失败: git {}", args.join(" "))
        } else {
            stderr
        })
    }
}

async fn run_git_text(repo_path: &str, args: &[&str]) -> Result<String, String> {
    run_git_bytes(repo_path, args)
        .await
        .map(|bytes| String::from_utf8_lossy(&bytes).trim().to_string())
}

async fn git_object_exists(repo_path: &str, object: &str) -> bool {
    let mut command = new_git_command(repo_path, &["cat-file", "-e", object]);
    tokio::time::timeout(
        Duration::from_millis(GIT_IMAGE_TIMEOUT_MS),
        command.status(),
    )
    .await
    .ok()
    .and_then(Result::ok)
    .map(|status| status.success())
    .unwrap_or(false)
}

async fn read_git_blob(repo_path: &str, object: &str) -> Result<ImageSource, String> {
    if !git_object_exists(repo_path, object).await {
        return Ok(ImageSource::Missing);
    }
    let byte_size = run_git_text(repo_path, &["cat-file", "-s", object])
        .await?
        .parse::<u64>()
        .map_err(|_| format!("无法读取图片对象大小: {}", object))?;
    if byte_size > IMAGE_SOURCE_MAX_BYTES {
        return Ok(ImageSource::TooLarge(byte_size));
    }
    let bytes = run_git_bytes(repo_path, &["cat-file", "blob", object]).await?;
    Ok(ImageSource::Bytes(bytes))
}

async fn read_worktree_file(repo_path: &Path, relative_path: &str) -> Result<ImageSource, String> {
    let absolute_path = repo_path.join(relative_path);
    let metadata = match tokio::fs::symlink_metadata(&absolute_path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(ImageSource::Missing),
        Err(error) => return Err(format!("无法读取图片 metadata: {}", error)),
    };
    if metadata.file_type().is_symlink() {
        return Err("暂不预览符号链接指向的图片".to_string());
    }
    if !metadata.is_file() {
        return Ok(ImageSource::Missing);
    }
    if metadata.len() > IMAGE_SOURCE_MAX_BYTES {
        return Ok(ImageSource::TooLarge(metadata.len()));
    }

    let canonical_repo = tokio::fs::canonicalize(repo_path)
        .await
        .map_err(|error| format!("无法解析仓库路径: {}", error))?;
    let canonical_file = tokio::fs::canonicalize(&absolute_path)
        .await
        .map_err(|error| format!("无法解析图片路径: {}", error))?;
    if !canonical_file.starts_with(&canonical_repo) {
        return Err("图片路径超出仓库目录".to_string());
    }

    tokio::fs::read(&canonical_file)
        .await
        .map(ImageSource::Bytes)
        .map_err(|error| format!("无法读取图片文件: {}", error))
}

fn extension(path: &str) -> String {
    Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
}

fn descriptor(mime_type: &'static str, label: &'static str) -> ImageDescriptor {
    ImageDescriptor {
        mime_type,
        label,
        is_svg: false,
    }
}

fn svg_descriptor() -> ImageDescriptor {
    ImageDescriptor {
        mime_type: "image/svg+xml",
        label: "SVG",
        is_svg: true,
    }
}

fn descriptor_from_extension(path: &str) -> Option<ImageDescriptor> {
    Some(match extension(path).as_str() {
        "png" | "apng" => descriptor("image/png", "PNG/APNG"),
        "jpg" | "jpeg" | "jpe" | "jfif" | "pjpeg" | "pjp" => descriptor("image/jpeg", "JPEG"),
        "gif" => descriptor("image/gif", "GIF"),
        "webp" => descriptor("image/webp", "WebP"),
        "avif" => descriptor("image/avif", "AVIF"),
        "svg" => svg_descriptor(),
        "bmp" | "dib" => descriptor("image/bmp", "BMP"),
        "ico" => descriptor("image/x-icon", "ICO"),
        "cur" => descriptor("image/x-icon", "CUR"),
        "tif" | "tiff" => descriptor("image/tiff", "TIFF"),
        "heic" | "heics" => descriptor("image/heic", "HEIC"),
        "heif" | "heifs" | "hif" => descriptor("image/heif", "HEIF"),
        "jxl" => descriptor("image/jxl", "JPEG XL"),
        "jp2" | "jpf" | "jpx" | "jpm" | "mj2" => descriptor("image/jp2", "JPEG 2000"),
        "j2k" | "j2c" => descriptor("image/j2k", "JPEG 2000 codestream"),
        "icns" => descriptor("image/icns", "ICNS"),
        "tga" | "icb" | "vda" | "vst" => descriptor("image/x-tga", "TGA"),
        "dds" => descriptor("image/vnd-ms.dds", "DDS"),
        "qoi" => descriptor("image/qoi", "QOI"),
        "pnm" | "pam" => descriptor("image/x-portable-anymap", "PNM/PAM"),
        "pbm" => descriptor("image/x-portable-bitmap", "PBM"),
        "pgm" => descriptor("image/x-portable-graymap", "PGM"),
        "ppm" => descriptor("image/x-portable-pixmap", "PPM"),
        "hdr" | "pic" | "rgbe" | "xyze" => descriptor("image/vnd.radiance", "Radiance HDR"),
        "exr" => descriptor("image/x-exr", "OpenEXR"),
        "psd" | "psb" => descriptor("image/vnd.adobe.photoshop", "Photoshop"),
        "ktx" => descriptor("image/ktx", "KTX"),
        "ktx2" => descriptor("image/ktx2", "KTX2"),
        "wbmp" => descriptor("image/vnd.wap.wbmp", "WBMP"),
        "ff" | "farbfeld" => descriptor("image/farbfeld", "farbfeld"),
        _ => return None,
    })
}

fn starts_with(bytes: &[u8], prefix: &[u8]) -> bool {
    bytes.len() >= prefix.len() && &bytes[..prefix.len()] == prefix
}

fn looks_like_svg(bytes: &[u8]) -> bool {
    let prefix = &bytes[..bytes.len().min(4_096)];
    let text = String::from_utf8_lossy(prefix).to_ascii_lowercase();
    text.contains("<svg")
}

fn descriptor_from_magic(bytes: &[u8]) -> Option<ImageDescriptor> {
    if starts_with(bytes, &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        return Some(descriptor("image/png", "PNG/APNG"));
    }
    if starts_with(bytes, &[0xff, 0xd8, 0xff]) {
        return Some(descriptor("image/jpeg", "JPEG"));
    }
    if starts_with(bytes, b"GIF87a") || starts_with(bytes, b"GIF89a") {
        return Some(descriptor("image/gif", "GIF"));
    }
    if bytes.len() >= 12 && starts_with(bytes, b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some(descriptor("image/webp", "WebP"));
    }
    if starts_with(bytes, b"BM") {
        return Some(descriptor("image/bmp", "BMP"));
    }
    if starts_with(bytes, &[0, 0, 1, 0]) {
        return Some(descriptor("image/x-icon", "ICO"));
    }
    if starts_with(bytes, &[0, 0, 2, 0]) {
        return Some(descriptor("image/x-icon", "CUR"));
    }
    if starts_with(bytes, b"II*\0") || starts_with(bytes, b"MM\0*") {
        return Some(descriptor("image/tiff", "TIFF"));
    }
    if starts_with(bytes, b"qoif") {
        return Some(descriptor("image/qoi", "QOI"));
    }
    if starts_with(bytes, b"DDS ") {
        return Some(descriptor("image/vnd-ms.dds", "DDS"));
    }
    if starts_with(bytes, &[0x76, 0x2f, 0x31, 0x01]) {
        return Some(descriptor("image/x-exr", "OpenEXR"));
    }
    if starts_with(bytes, b"8BPS") {
        return Some(descriptor("image/vnd.adobe.photoshop", "Photoshop"));
    }
    if starts_with(bytes, b"#?RADIANCE") || starts_with(bytes, b"#?RGBE") {
        return Some(descriptor("image/vnd.radiance", "Radiance HDR"));
    }
    if starts_with(bytes, b"farbfeld") {
        return Some(descriptor("image/farbfeld", "farbfeld"));
    }
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        let brand = &bytes[8..12];
        if brand == b"avif" || brand == b"avis" {
            return Some(descriptor("image/avif", "AVIF"));
        }
        if brand == b"heic"
            || brand == b"heix"
            || brand == b"hevc"
            || brand == b"hevx"
            || brand == b"heim"
            || brand == b"heis"
        {
            return Some(descriptor("image/heic", "HEIC"));
        }
        if brand == b"mif1" || brand == b"msf1" {
            return Some(descriptor("image/heif", "HEIF"));
        }
        if brand == b"jp2 " || brand == b"jpx " || brand == b"jpm " {
            return Some(descriptor("image/jp2", "JPEG 2000"));
        }
    }
    if looks_like_svg(bytes) {
        return Some(svg_descriptor());
    }
    None
}

fn detect_descriptor(path: &str, bytes: &[u8]) -> Option<ImageDescriptor> {
    descriptor_from_magic(bytes).or_else(|| descriptor_from_extension(path))
}

fn validate_svg(bytes: &[u8]) -> Result<(), String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "SVG 不是有效 UTF-8 文本".to_string())?;
    let lower = text.to_ascii_lowercase();
    if !lower.contains("<svg") {
        return Err("文件内容不是 SVG".to_string());
    }
    let external_scan = lower
        .replace("http://www.w3.org/2000/svg", "")
        .replace("https://www.w3.org/2000/svg", "")
        .replace("http://www.w3.org/1999/xlink", "")
        .replace("https://www.w3.org/1999/xlink", "");
    let forbidden = [
        "<script",
        "<foreignobject",
        "<!doctype",
        "<!entity",
        "javascript:",
        "vbscript:",
        "file://",
        "ftp://",
        "http://",
        "https://",
        "data:text/html",
        "onload=",
        "onerror=",
        "onclick=",
        "onbegin=",
        "onend=",
        "onrepeat=",
        "onfocus=",
        "onmouseover=",
        "url(http",
        "url(https",
        "url(file",
        "url(javascript",
    ];
    if let Some(token) = forbidden
        .iter()
        .find(|token| external_scan.contains(**token))
    {
        return Err(format!("SVG 包含不安全或外部资源引用：{}", token));
    }
    Ok(())
}

fn encode_base64(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    let mut index = 0usize;
    while index < bytes.len() {
        let first = bytes[index];
        let second = bytes.get(index + 1).copied().unwrap_or(0);
        let third = bytes.get(index + 2).copied().unwrap_or(0);

        output.push(BASE64_ALPHABET[(first >> 2) as usize] as char);
        output
            .push(BASE64_ALPHABET[(((first & 0b0000_0011) << 4) | (second >> 4)) as usize] as char);
        if index + 1 < bytes.len() {
            output.push(
                BASE64_ALPHABET[(((second & 0b0000_1111) << 2) | (third >> 6)) as usize] as char,
            );
        } else {
            output.push('=');
        }
        if index + 2 < bytes.len() {
            output.push(BASE64_ALPHABET[(third & 0b0011_1111) as usize] as char);
        } else {
            output.push('=');
        }
        index += 3;
    }
    output
}

fn side_from_source(path: &str, source_label: &str, source: ImageSource) -> RepoImagePreviewSide {
    match source {
        ImageSource::Missing => empty_side(path, source_label, "该版本不存在"),
        ImageSource::TooLarge(byte_size) => too_large_side(path, source_label, byte_size),
        ImageSource::Bytes(bytes) => {
            let Some(descriptor) = detect_descriptor(path, &bytes) else {
                return empty_side(
                    path,
                    source_label,
                    format!("无法识别为受支持的图片。当前支持：{}", SUPPORTED_FORMATS),
                );
            };
            if descriptor.is_svg {
                if let Err(error) = validate_svg(&bytes) {
                    return empty_side(path, source_label, error);
                }
            }
            RepoImagePreviewSide {
                available: true,
                path: path.to_string(),
                source_label: source_label.to_string(),
                mime_type: descriptor.mime_type.to_string(),
                data_url: format!(
                    "data:{};base64,{}",
                    descriptor.mime_type,
                    encode_base64(&bytes)
                ),
                byte_size: bytes.len() as u64,
                width: None,
                height: None,
                original_format: descriptor.label.to_string(),
                preview_format: descriptor.label.to_string(),
                converted: false,
                is_too_large: false,
                message: String::new(),
            }
        }
    }
}

async fn git_side(
    repo_path: &str,
    object: Option<String>,
    path: &str,
    label: &str,
) -> RepoImagePreviewSide {
    let Some(object) = object else {
        return empty_side(path, label, "该版本不存在");
    };
    match read_git_blob(repo_path, &object).await {
        Ok(source) => side_from_source(path, label, source),
        Err(error) => empty_side(path, label, error),
    }
}

async fn worktree_side(repo_path: &Path, path: &str, label: &str) -> RepoImagePreviewSide {
    match read_worktree_file(repo_path, path).await {
        Ok(source) => side_from_source(path, label, source),
        Err(error) => empty_side(path, label, error),
    }
}

async fn resolve_commit_hash(repo_path: &str, commit_hash: &str) -> Result<String, String> {
    let normalized = commit_hash.trim();
    if normalized.is_empty() {
        return Err("Commit hash 不能为空".to_string());
    }
    let commit_ref = format!("{}^{{commit}}", normalized);
    run_git_text(repo_path, &["rev-parse", "--verify", &commit_ref]).await
}

async fn first_parent_hash(repo_path: &str, full_hash: &str) -> Option<String> {
    run_git_text(repo_path, &["show", "-s", "--format=%P", full_hash])
        .await
        .ok()
        .and_then(|parents| parents.split_whitespace().next().map(ToString::to_string))
}

async fn head_hash(repo_path: &str) -> Option<String> {
    run_git_text(repo_path, &["rev-parse", "--verify", "HEAD"])
        .await
        .ok()
        .filter(|value| !value.is_empty())
}

fn build_response(
    before: RepoImagePreviewSide,
    after: RepoImagePreviewSide,
) -> RepoImageDiffPreview {
    RepoImageDiffPreview {
        has_visual_diff: before.available || after.available,
        before,
        after,
        supported_formats: SUPPORTED_FORMATS.to_string(),
    }
}

#[tauri::command]
pub async fn get_repo_commit_image_diff_preview(
    repo_path: String,
    commit_hash: String,
    path: String,
    old_path: Option<String>,
    state: State<'_, AppState>,
) -> Result<RepoImageDiffPreview, String> {
    ensure_repo_path(&repo_path)?;
    let path = normalize_relative_path(&path)?;
    let old_path = old_path
        .as_deref()
        .map(normalize_relative_path)
        .transpose()?;
    let _guard = acquire_repo_git_read_guard(&state, &repo_path).await?;
    let full_hash = resolve_commit_hash(&repo_path, &commit_hash).await?;
    let parent_hash = first_parent_hash(&repo_path, &full_hash).await;
    let before_path = old_path.as_deref().unwrap_or(path.as_str());
    let before_object = parent_hash.map(|parent| format!("{}:{}", parent, before_path));
    let after_object = Some(format!("{}:{}", full_hash, path));
    let before = git_side(&repo_path, before_object, before_path, "修改前").await;
    let after = git_side(&repo_path, after_object, &path, "修改后").await;
    Ok(build_response(before, after))
}

#[tauri::command]
pub async fn get_repo_working_image_diff_preview(
    repo_path: String,
    path: String,
    old_path: Option<String>,
    state: State<'_, AppState>,
) -> Result<RepoImageDiffPreview, String> {
    let repo = ensure_repo_path(&repo_path)?;
    let path = normalize_relative_path(&path)?;
    let old_path = old_path
        .as_deref()
        .map(normalize_relative_path)
        .transpose()?;
    let _guard = acquire_repo_git_read_guard(&state, &repo_path).await?;
    let before_path = old_path.as_deref().unwrap_or(path.as_str());
    let before_object = head_hash(&repo_path)
        .await
        .map(|head| format!("{}:{}", head, before_path));
    let before = git_side(&repo_path, before_object, before_path, "HEAD").await;
    let after = worktree_side(&repo, &path, "工作区").await;
    Ok(build_response(before, after))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_parent_and_absolute_paths() {
        assert!(normalize_relative_path("../secret.png").is_err());
        assert!(normalize_relative_path("/tmp/image.png").is_err());
        assert!(normalize_relative_path("C:\\temp\\image.png").is_err());
        assert_eq!(
            normalize_relative_path("src/icons/icon.png").unwrap(),
            "src/icons/icon.png"
        );
    }

    #[test]
    fn detects_common_and_extended_image_formats() {
        assert_eq!(
            detect_descriptor(
                "icon.png",
                &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]
            )
            .unwrap()
            .mime_type,
            "image/png"
        );
        assert_eq!(
            detect_descriptor("asset.qoi", b"qoifdemo")
                .unwrap()
                .mime_type,
            "image/qoi"
        );
        assert_eq!(
            detect_descriptor("photo.heic", b"not-enough-for-magic")
                .unwrap()
                .mime_type,
            "image/heic"
        );
        assert!(detect_descriptor("archive.zip", b"PK\x03\x04").is_none());
    }

    #[test]
    fn validates_svg_without_active_or_external_content() {
        assert!(validate_svg(
            b"<svg xmlns='http://www.w3.org/2000/svg'><rect width='1' height='1'/></svg>"
        )
        .is_ok());
        assert!(validate_svg(b"<svg><script>alert(1)</script></svg>").is_err());
        assert!(validate_svg(b"<svg><image href='https://example.com/a.png'/></svg>").is_err());
        assert!(validate_svg(b"<svg><rect fill='url(#gradient)'/></svg>").is_ok());
    }

    #[test]
    fn base64_encoder_matches_known_vectors() {
        assert_eq!(encode_base64(b""), "");
        assert_eq!(encode_base64(b"f"), "Zg==");
        assert_eq!(encode_base64(b"fo"), "Zm8=");
        assert_eq!(encode_base64(b"foo"), "Zm9v");
        assert_eq!(encode_base64(b"foobar"), "Zm9vYmFy");
    }
}
