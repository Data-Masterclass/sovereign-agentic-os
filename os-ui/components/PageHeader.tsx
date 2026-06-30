import type { GoldenPathKey } from '@/lib/tutorials/types';
import TutorialLink from '@/components/tutorials/TutorialLink';

export default function PageHeader({
  title,
  crumb,
  tutorial,
}: {
  title: string;
  crumb?: string;
  /** If set, shows a "Tutorial" link that opens this path's tutorial overlay. */
  tutorial?: GoldenPathKey;
}) {
  return (
    <div className="topbar">
      <div>
        <h1>{title}</h1>
        {crumb ? <div className="crumb">{crumb}</div> : null}
      </div>
      <div className="topbar-actions">
        {tutorial ? <TutorialLink tutorial={tutorial} variant="header" /> : null}
        <span className="pill">
          <span className="live" />
          Live cluster
        </span>
      </div>
    </div>
  );
}
