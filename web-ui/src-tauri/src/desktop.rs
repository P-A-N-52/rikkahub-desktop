use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WindowEvent,
};
#[cfg(target_os = "macos")]
use tauri::{
    menu::{PredefinedMenuItem, Submenu},
    Emitter,
};

use crate::{config::load_user_config, startup};

fn is_chinese() -> bool {
    sys_locale::get_locale().is_some_and(|locale| locale.starts_with("zh"))
}

pub(crate) fn minimize_to_tray_enabled(app: &AppHandle) -> Result<bool, String> {
    Ok(load_user_config(app)?.minimize_to_tray.unwrap_or(true))
}

pub(crate) fn show_main_window(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    if let Err(error) = app.show() {
        startup::log(&format!("Failed to unhide application: {error}"));
    }
    if let Some(window) = app.get_webview_window("main") {
        let result = window
            .unminimize()
            .and_then(|_| window.show())
            .and_then(|_| window.set_focus());
        if let Err(error) = result {
            startup::log(&format!("Failed to restore main window: {error}"));
        }
    }
}

pub(crate) fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        // Keep the window alive until the shared shutdown has finished, or hide it.
        api.prevent_close();
        let app = window.app_handle();
        match minimize_to_tray_enabled(app) {
            Ok(true) => {
                if let Err(error) = window.hide() {
                    startup::log(&format!("Failed to hide main window: {error}"));
                } else {
                    startup::log("Main window hidden; backend remains active");
                }
            }
            Ok(false) => app.exit(0),
            Err(error) => startup::show_error(app, "Rikkahub 配置错误", &error, false),
        }
    }
}

#[cfg(target_os = "macos")]
fn install_menu(app: &AppHandle) -> tauri::Result<()> {
    let zh = is_chinese();
    let text = |chinese, english| if zh { chinese } else { english };
    let app_menu = Submenu::with_items(
        app,
        "Rikkahub",
        true,
        &[
            &PredefinedMenuItem::about(app, Some(text("关于 Rikkahub", "About Rikkahub")), None)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "app_settings",
                text("设置…", "Settings…"),
                true,
                // The configurable web shortcut owns this key, including disabled/recording states.
                None::<&str>,
            )?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, Some(text("服务", "Services")))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some(text("隐藏 Rikkahub", "Hide Rikkahub")))?,
            &PredefinedMenuItem::hide_others(app, Some(text("隐藏其他", "Hide Others")))?,
            &PredefinedMenuItem::show_all(app, Some(text("显示全部", "Show All")))?,
            &PredefinedMenuItem::separator(app)?,
            // Explicit app.exit enters ExitRequested before plugin teardown. The native
            // predefined Quit action can terminate the Cocoa loop directly.
            &MenuItem::with_id(
                app,
                "app_quit",
                text("退出 Rikkahub", "Quit Rikkahub"),
                true,
                Some("CmdOrCtrl+Q"),
            )?,
        ],
    )?;
    let file_menu = Submenu::with_items(
        app,
        text("文件", "File"),
        true,
        &[&MenuItem::with_id(
            app,
            "window_close",
            text("关闭窗口", "Close Window"),
            true,
            Some("CmdOrCtrl+W"),
        )?],
    )?;
    let edit_menu = Submenu::with_items(
        app,
        text("编辑", "Edit"),
        true,
        &[
            &PredefinedMenuItem::undo(app, Some(text("撤销", "Undo")))?,
            &PredefinedMenuItem::redo(app, Some(text("重做", "Redo")))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some(text("剪切", "Cut")))?,
            &PredefinedMenuItem::copy(app, Some(text("复制", "Copy")))?,
            &PredefinedMenuItem::paste(app, Some(text("粘贴", "Paste")))?,
            &PredefinedMenuItem::select_all(app, Some(text("全选", "Select All")))?,
        ],
    )?;
    let window_menu = Submenu::with_items(
        app,
        text("窗口", "Window"),
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some(text("最小化", "Minimize")))?,
            &PredefinedMenuItem::maximize(app, Some(text("缩放", "Zoom")))?,
            &PredefinedMenuItem::fullscreen(app, Some(text("切换全屏", "Toggle Full Screen")))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "window_show",
                text("显示主窗口", "Show Main Window"),
                true,
                None::<&str>,
            )?,
            &PredefinedMenuItem::bring_all_to_front(
                app,
                Some(text("全部置于顶层", "Bring All to Front")),
            )?,
        ],
    )?;
    app.set_menu(Menu::with_items(
        app,
        &[&app_menu, &file_menu, &edit_menu, &window_menu],
    )?)?;
    window_menu.set_as_windows_menu_for_nsapp()?;
    app.on_menu_event(|app, event| match event.id.as_ref() {
        "app_quit" => app.exit(0),
        "window_close" => {
            if let Some(window) = app.get_webview_window("main") {
                if let Err(error) = window.close() {
                    startup::log(&format!("Failed to request window close: {error}"));
                }
            }
        }
        "window_show" => show_main_window(app),
        "app_settings" => {
            show_main_window(app);
            if let Err(error) = app.emit("desktop://settings", ()) {
                startup::log(&format!("Failed to open settings: {error}"));
            }
        }
        _ => {}
    });
    Ok(())
}

fn tray_icon(scale: f64, template: bool) -> Result<tauri::image::Image<'static>, String> {
    let target = ((16.0 * scale).round() as u32).clamp(16, 64);
    let master = image::load_from_memory_with_format(
        include_bytes!("../icons/128x128@2x.png"),
        image::ImageFormat::Png,
    )
    .map_err(|error| error.to_string())?;
    let mut pixels = master.into_rgba8();
    if template {
        // The app icon has a white disc. Extract the dark mark as opacity before
        // scaling; retaining that disc's alpha would produce a solid status dot.
        for pixel in pixels.pixels_mut() {
            let brightness = (u16::from(pixel[0]) + u16::from(pixel[1]) + u16::from(pixel[2])) / 3;
            pixel[3] = (u16::from(pixel[3]) * (255 - brightness) / 255) as u8;
            pixel.0[..3].fill(0);
        }
    }
    let pixels = image::imageops::resize(
        &pixels,
        target,
        target,
        image::imageops::FilterType::Lanczos3,
    );
    Ok(tauri::image::Image::new_owned(
        pixels.into_raw(),
        target,
        target,
    ))
}

fn build_tray(app: &AppHandle) -> Result<(), String> {
    let zh = is_chinese();
    let show = MenuItem::with_id(
        app,
        "tray_show",
        if zh { "显示主窗口" } else { "Show window" },
        true,
        None::<&str>,
    )
    .map_err(|error| error.to_string())?;
    let quit = MenuItem::with_id(
        app,
        "tray_quit",
        if zh {
            "退出 Rikkahub"
        } else {
            "Quit Rikkahub"
        },
        true,
        None::<&str>,
    )
    .map_err(|error| error.to_string())?;
    let menu = Menu::with_items(app, &[&show, &quit]).map_err(|error| error.to_string())?;
    let scale = app
        .primary_monitor()
        .map_err(|error| error.to_string())?
        .map(|monitor| monitor.scale_factor())
        .unwrap_or(1.0);
    let template = cfg!(target_os = "macos");
    TrayIconBuilder::with_id("main-tray")
        .icon(tray_icon(scale, template)?)
        .icon_as_template(template)
        .tooltip("Rikkahub")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray_show" => show_main_window(app),
            "tray_quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn initialize(app: &AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let window = app
            .get_webview_window("main")
            .ok_or("Main window is missing")?;
        // Apply the platform choice before the first show without duplicating the
        // shared window configuration array or restoring obsolete decorations.
        window
            .set_decorations(true)
            .map_err(|error| error.to_string())?;
        window
            .set_title_bar_style(tauri::TitleBarStyle::Visible)
            .map_err(|error| error.to_string())?;
        install_menu(app).map_err(|error| error.to_string())?;
    }
    if let Err(error) = build_tray(app) {
        // Dock and the app menu remain available on macOS if a status item fails.
        startup::log(&format!("Tray unavailable: {error}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn template_icon_removes_the_white_disc_and_retains_the_mark_at_retina_scale() {
        let template = tray_icon(2.0, true).unwrap();
        let original = tray_icon(2.0, false).unwrap();
        assert_eq!((template.width(), template.height()), (32, 32));
        assert!(template.rgba().chunks_exact(4).any(|pixel| pixel[3] > 0));
        assert!(template
            .rgba()
            .chunks_exact(4)
            .all(|pixel| pixel[..3] == [0, 0, 0]));
        let template_ink: usize = template
            .rgba()
            .chunks_exact(4)
            .map(|pixel| usize::from(pixel[3]))
            .sum();
        let original_ink: usize = original
            .rgba()
            .chunks_exact(4)
            .map(|pixel| usize::from(pixel[3]))
            .sum();
        assert!(
            template_ink > original_ink / 10,
            "rabbit mark must remain visible"
        );
        assert!(
            template_ink < original_ink / 2,
            "white background must be transparent"
        );
    }
}
