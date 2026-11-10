import { Combobox } from '@base-ui/react/combobox';
import { useId } from 'react';
import { ALL_COUNTRIES, countryName } from '../lib/countries';
import { IconCheck, IconClose } from './Icons';

/** Seletor de vários países (Combobox do Base UI): busca pelo nome em pt-BR ou pelo código. */
export function CountryPicker({
  value,
  onChange,
  label,
  invalid,
}: {
  value: string[];
  onChange: (codes: string[]) => void;
  label: string;
  invalid?: boolean;
}) {
  const id = useId();
  return (
    <Combobox.Root
      items={ALL_COUNTRIES}
      multiple
      value={value}
      onValueChange={(v) => onChange(v as string[])}
      itemToStringLabel={(code: string) => `${countryName(code)} ${code}`}
    >
      <div className="campo-grupo">
        <label className="campo-rotulo" htmlFor={id}>
          {label}
        </label>
        <Combobox.InputGroup className="campo paises" data-invalid={invalid || undefined}>
          <Combobox.Chips className="paises-chips">
            {value.map((code) => (
              <Combobox.Chip key={code} className="chip paises-chip" aria-label={countryName(code)}>
                <span className="mono">{code}</span>
                <Combobox.ChipRemove
                  className="paises-remover"
                  aria-label={`Tirar ${countryName(code)}`}
                >
                  <IconClose width={12} height={12} />
                </Combobox.ChipRemove>
              </Combobox.Chip>
            ))}
            <Combobox.Input
              id={id}
              className="paises-input"
              placeholder={value.length ? '' : 'Brasil, Portugal…'}
              aria-invalid={invalid || undefined}
            />
          </Combobox.Chips>
        </Combobox.InputGroup>
      </div>
      <Combobox.Portal>
        <Combobox.Positioner className="camada-pop" sideOffset={4}>
          <Combobox.Popup className="flutuante popup menu paises-popup">
            <Combobox.Empty className="menu-vazio">Nenhum país com esse nome.</Combobox.Empty>
            <Combobox.List>
              {(code: string) => (
                <Combobox.Item key={code} value={code} className="menu-item">
                  <Combobox.ItemIndicator className="paises-marca">
                    <IconCheck />
                  </Combobox.ItemIndicator>
                  <span className="mono paises-codigo">{code}</span>
                  {countryName(code)}
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
