Two sessions means two segment files under the event-log root. The reader's
`replay_session` must filter by session id; `replay_all` must walk both
segments and return every record. Pins the per-session-per-file segment
layout introduced in `ZstdSegmentedEventLog`.
