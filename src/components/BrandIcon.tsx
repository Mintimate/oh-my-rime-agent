import brandIconUrl from '../../favicon.svg?url';

export function BrandIcon({ size = 40, className = '' }: { size?: number; className?: string }) {
  return <img className={`brand-icon ${className}`} src={brandIconUrl} width={size} height={size} alt="" aria-hidden="true" />;
}
