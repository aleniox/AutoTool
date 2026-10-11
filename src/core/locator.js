/**
 * Bo phan giai "locator descriptor" -> Playwright Locator.
 *
 * Nen tang thay doi DOM lien tuc, nen moi descriptor co the la MOT MANG cac
 * phuong an. Ham findVisible() se thu lan luot va tra ve cai nao hien thi truoc.
 *
 * Cac dang descriptor duoc ho tro:
 *   'div.foo'                          -> CSS
 *   { css: 'div.foo' }                 -> CSS
 *   { text: 'Dang', exact: false }     -> getByText
 *   { role: 'button', name: 'Dang' }   -> getByRole
 *   { placeholder: '...' }             -> getByPlaceholder
 *   { label: '...' }                   -> getByLabel
 *   { testid: '...' }                  -> getByTestId
 *   { title: '...' } / { alt: '...' }  -> getByTitle / getByAltText
 *   { xpath: '...' }                   -> xpath=
 *   { index: 2, css: '...' }           -> lay phan tu thu N thay vi phan tu dau
 *   [ d1, d2, d3 ]                     -> thu lan luot
 */

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function candidates(desc) {
  if (desc === null || desc === undefined) return [];
  if (Array.isArray(desc)) return desc.flatMap(candidates);
  return [desc];
}

export function buildLocator(scope, desc) {
  if (typeof desc === 'string') return scope.locator(desc);
  if (!desc || typeof desc !== 'object') {
    throw new Error(`Locator descriptor khong hop le: ${JSON.stringify(desc)}`);
  }
  if (desc.css) return scope.locator(desc.css);
  if (desc.xpath) return scope.locator(`xpath=${desc.xpath}`);
  if (desc.text !== undefined) return scope.getByText(desc.text, { exact: !!desc.exact });
  if (desc.role) return scope.getByRole(desc.role, { name: desc.name, exact: !!desc.exact });
  if (desc.placeholder) return scope.getByPlaceholder(desc.placeholder, { exact: !!desc.exact });
  if (desc.label) return scope.getByLabel(desc.label, { exact: !!desc.exact });
  if (desc.testid) return scope.getByTestId(desc.testid);
  if (desc.title) return scope.getByTitle(desc.title, { exact: !!desc.exact });
  if (desc.alt) return scope.getByAltText(desc.alt, { exact: !!desc.exact });
  if (desc.selector) return scope.locator(desc.selector);
  throw new Error(`Locator descriptor khong hop le: ${JSON.stringify(desc)}`);
}

async function isVisible(loc) {
  try {
    if ((await loc.count()) === 0) return false;
    return await loc.first().isVisible();
  } catch {
    return false;
  }
}

function applyIndex(loc, desc) {
  const idx = typeof desc === 'object' && desc !== null ? desc.index : undefined;
  if (Number.isInteger(idx)) return loc.nth(idx);
  return loc.first();
}

/**
 * Tim locator hien thi dau tien trong danh sach phuong an.
 * @returns {Promise<import('playwright').Locator|null>}
 */
export async function findVisible(scope, desc, { timeout = 15000, pollMs = 250 } = {}) {
  const list = candidates(desc);
  if (!list.length) return null;
  const deadline = Date.now() + Math.max(0, timeout);

  do {
    for (const c of list) {
      let loc;
      try {
        loc = buildLocator(scope, c);
      } catch {
        continue;
      }
      const target = applyIndex(loc, c);
      if (await isVisible(target)) return target;
    }
    if (Date.now() >= deadline) break;
    await sleep(pollMs);
  } while (Date.now() < deadline);

  return null;
}

/** Cho den khi locator hien thi, nem loi neu het thoi gian. */
export async function requireVisible(scope, desc, { timeout = 15000, label = '' } = {}) {
  const loc = await findVisible(scope, desc, { timeout });
  if (!loc) {
    throw new Error(`Khong tim thay phan tu${label ? ` (${label})` : ''}: ${describe(desc)}`);
  }
  return loc;
}

/** Kiem tra nhanh (khong cho) xem bat ky phuong an nao dang hien thi. */
export async function anyVisible(scope, desc) {
  return (await findVisible(scope, desc, { timeout: 0 })) !== null;
}

export function describe(desc) {
  const list = candidates(desc);
  return list
    .map((d) => (typeof d === 'string' ? d : JSON.stringify(d)))
    .join(' | ');
}

export default { findVisible, requireVisible, anyVisible, buildLocator, candidates, describe, sleep };
