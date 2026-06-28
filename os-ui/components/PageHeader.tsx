export default function PageHeader({
  title,
  crumb,
}: {
  title: string;
  crumb?: string;
}) {
  return (
    <div className="topbar">
      <div>
        <h1>{title}</h1>
        {crumb ? <div className="crumb">{crumb}</div> : null}
      </div>
      <span className="pill">
        <span className="live" />
        Live cluster
      </span>
    </div>
  );
}
