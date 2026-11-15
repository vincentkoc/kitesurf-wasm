// Linux smaps reports resident pages, not reserved address space or live object bytes.
export function executableAnonymousRssKiB(smaps) {
  let selected = false;
  let pending = false;
  let total = 0;
  let mappings = 0;
  for (const line of smaps.split('\n')) {
    const header = /^[0-9a-f]+-[0-9a-f]+\s+([rwxps-]{4})\s+[0-9a-f]+\s+[0-9a-f]+:[0-9a-f]+\s+\d+\s*(.*)$/i.exec(line);
    if (header) {
      if (pending) throw Error('Missing RSS for executable anonymous mapping');
      mappings++;
      selected = header[1].includes('x') && (!header[2] || header[2].startsWith('['));
      pending = selected;
    } else if (selected && line.startsWith('Rss:')) {
      const rss = /^Rss:\s+(\d+)\s+kB$/.exec(line);
      if (!rss || !pending) throw Error('Invalid RSS for executable anonymous mapping');
      total += Number(rss[1]);
      pending = false;
    }
  }
  if (!mappings || pending) throw Error('Incomplete smaps');
  return total;
}
