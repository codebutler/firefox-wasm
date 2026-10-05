// Date op family (Date.now / Date.parse / new Date(ms) + getters): MDateNow,
// MDateParse, MTimeClip, MNewDateObject, MDateFillLocalTimeSlots,
// MDate{Hours,Minutes,Seconds}FromSecondsIntoYear, M{Year,Month,Date}FromTime,
// MLocalTimeToUTC. Every one of these used to bail the whole function to PBL.
class Benchmark {
  setup() {
    this.n = 20000;
    this.base = Date.parse("2020-03-15T12:34:56Z");  // MDateParse
    this.step = 86400000;                            // one day in ms
  }
  runIteration() {
    let s = 0;
    let ticks = 0;
    for (let i = 0; i < this.n; i++) {
      ticks += Date.now() & 1;                       // MDateNow
      const d = new Date(this.base + i * this.step); // MTimeClip + MNewDateObject
      s += d.getFullYear()                           // FillLocalTimeSlots + slot read
         + d.getMonth() * 31                         // MMonthFromTime slot read
         + d.getDate() * 7                           // MDateFromTime slot read
         + d.getHours() * 13                         // MDateHoursFromSecondsIntoYear
         + d.getMinutes() * 17                       // MDateMinutesFromSecondsIntoYear
         + d.getSeconds() * 19                       // MDateSecondsFromSecondsIntoYear
         + d.getTimezoneOffset();                    // MLocalTimeToUTC
    }
    this.s = s;
    this.ticks = ticks & 1;
  }
  result() { return (this.s & 0x7fffffff) | 0; }
}
