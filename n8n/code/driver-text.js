// Writes one text for the driver from the changes a driver cares about,
// and nothing when there is nothing worth a text.

// Arrival time moves smaller than this are not worth a text.
const MIN_SHIFT_MINUTES = 10;

const texts = [];
for (const [index, item] of $input.all().entries()) {
  const event = $('Event type').itemMatching(index).json.body;
  const flight = event.flight;
  const pickup = item.json; // the row the form saved: passengerName, driverPhone
  if (!pickup.driverPhone) continue;

  const arr = flight.arrival;
  const number = `${flight.carrier.iata}${flight.flightNumber}`;
  const from = flight.departure.airport.city ?? flight.departure.airport.iata;
  const airport = arr.airport.iata;
  // Webhook times are UTC; the driver wants the arrival airport's clock.
  const clock = (utc) => DateTime.fromISO(utc).setZone(arr.airport.timezone).toFormat('HH:mm');
  const lands = (arr.times.estimatedGate ?? arr.times.scheduledGate)?.utc;
  const find = (type, path) =>
    event.changes.find((change) => change.type === type && (!path || change.path.endsWith(path)));

  const lines = [];
  if (find('flight.cancelled')) {
    lines.push(`${number} from ${from} is cancelled. Pickup on hold.`);
  } else if (find('flight.diverted')) {
    const to = flight.diverted ? ` to ${flight.diverted.airport.iata}` : '';
    lines.push(`${number} from ${from} is diverted${to}. Pickup on hold.`);
  } else {
    const moved = find('arrival.estimated.changed', 'Gate') ?? find('arrival.estimated.changed');
    if (find('flight.arrived')) {
      lines.push(`${number} is at the gate at ${airport}${arr.terminal ? `, terminal ${arr.terminal}` : ''}.`);
    } else if (find('flight.departed')) {
      lines.push(`${number} has left ${from}.${lands ? ` Lands about ${clock(lands)} at ${airport}.` : ''}`);
    } else if (moved?.from && moved.to && Math.abs(moved.deltaMinutes ?? 0) >= MIN_SHIFT_MINUTES) {
      lines.push(`${number} now lands about ${clock(moved.to)} at ${airport} (was ${clock(moved.from)}).`);
    }
    const terminal = find('arrival.terminal.changed');
    if (terminal?.to && !find('flight.arrived')) lines.push(`Arrives at terminal ${terminal.to}.`);
    const belt = find('arrival.baggage.changed');
    if (belt?.to) lines.push(`Bags on belt ${belt.to}.`);
  }
  if (lines.length === 0) continue;
  if (pickup.passengerName) lines.push(`Passenger: ${pickup.passengerName}.`);

  texts.push({ json: { flight: number, to: pickup.driverPhone, text: lines.join(' ') } });
}
return texts;
