import { FontAwesomeIcon, type FontAwesomeIconProps } from '@fortawesome/react-fontawesome';
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';

export type { IconDefinition };

export function Icon({ icon, className = '', spin = false, ...rest }: {
  icon: IconDefinition;
  className?: string;
  spin?: boolean;
} & Omit<FontAwesomeIconProps, 'icon' | 'className' | 'spin'>) {
  return <FontAwesomeIcon icon={icon} className={className} spin={spin} {...rest} />;
}
