// Temporary placeholder for views not yet ported to React. Keeps the app fully
// runnable at every migration phase: navigation works, the shell renders, and
// un-ported surfaces show a clear "porting in progress" panel instead of a
// blank screen or a crash. Each one is replaced by its real component as that
// phase lands.
export function Placeholder({ title, note }) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      <p className="muted">
        {note || "This view is being ported to the new React + TanStack frontend."}
      </p>
    </section>
  );
}
