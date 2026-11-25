import React from 'react';

interface MenuVersionSectionProps {
  appVersion: string;
  closeMenu: () => void;
}

export const MenuVersionSection: React.FC<MenuVersionSectionProps> = ({ appVersion, closeMenu }) => (
  <div className="flex items-center justify-between gap-3 px-3 py-2" data-menu-version="">
    <a
      href="https://github.com/backnotprop/plannotator"
      target="_blank"
      rel="noopener noreferrer"
      onClick={closeMenu}
      className="text-[10px] font-semibold tracking-wide text-muted-foreground hover:text-foreground transition-colors"
    >
      Plannotator
    </a>
    <span className="text-[10px] font-mono text-muted-foreground/70">
      v{appVersion}
    </span>
  </div>
);
