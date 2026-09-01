//! Telling every open page that the project changed.
//!
//! The signal is deliberately coarse: one named event carrying a fixed payload, and the page
//! answers it by loading the document again. The event carries no file, no module identity and no
//! graph state; the request path that follows it re-reads and re-transforms whatever the document
//! asks for at that moment.

/// The built-in module every served document loads.
pub(crate) const CLIENT_PATH: &str = "/@rsvite/client";

/// The stream that module listens to.
pub(crate) const EVENTS_PATH: &str = "/@rsvite/events";

/// The only event this server sends.
pub(crate) const RELOAD_EVENT: &str = "full-reload";

/// The reference appended to a served document.
///
/// It is absolute so that a document served from any path loads the same module, and it is
/// appended to the response rather than written into the project's file, so the project keeps the
/// HTML it wrote.
const CLIENT_TAG: &str = "\n<script type=\"module\" src=\"/@rsvite/client\"></script>\n";

/// The built-in client.
///
/// This server sends one event per edit window, and this is where several of them can become one
/// navigation: a document that has already started loading the next one ignores the rest. The
/// events are ephemeral and carry no state, so without that a burst arriving during a navigation
/// would queue one navigation for each of them.
const CLIENT_SOURCE: &str = r#"const events = new EventSource("/@rsvite/events");
let reloading = false;

events.addEventListener("full-reload", () => {
  if (reloading) {
    return;
  }
  reloading = true;
  location.reload();
});
"#;

pub(crate) fn client_source() -> &'static str {
    CLIENT_SOURCE
}

/// The document this response was built from, followed by the built-in client.
///
/// What arrives here is whatever the root request selected: the project's own bytes, or the
/// replacement a declared hook returned for them.
pub(crate) fn with_client_reference(mut document: Vec<u8>) -> Vec<u8> {
    document.extend_from_slice(CLIENT_TAG.as_bytes());
    document
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_the_client_without_changing_the_document() {
        let project_html = b"<h1>hello</h1>\n".to_vec();
        let served = with_client_reference(project_html.clone());
        let served_text = String::from_utf8(served).unwrap();

        assert!(
            served_text.starts_with(&String::from_utf8(project_html).unwrap()),
            "{served_text}"
        );
        assert!(
            served_text.contains("<script type=\"module\" src=\"/@rsvite/client\"></script>"),
            "{served_text}"
        );
    }

    #[test]
    fn the_client_listens_for_the_event_this_server_sends() {
        assert!(client_source().contains(RELOAD_EVENT));
        assert!(client_source().contains(EVENTS_PATH));
    }
}
