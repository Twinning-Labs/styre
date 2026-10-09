#!/usr/bin/perl
# test/lifecycle/fixtures/wait-status.pl: runs its command as a child and writes how the child ended
# to the file named first, as JSON: {"signal":<number>,"core":<true|false>,"code":<number>}. "core" is
# the wait status's WCOREDUMP bit: the kernel sets it whenever it dumped the child's core, to a file
# or to a program core_pattern pipes to, which no Bun API reports. Keystroke signals reach it too in a
# terminal: it catches them (a caught signal is reset in the child, which starts with defaults) and
# keeps waiting. It writes the file through a temporary file and a rename.
use strict;
use warnings;

my $out = shift @ARGV or die "usage: wait-status.pl <file> <command…>\n";
$SIG{$_} = sub { } for qw(INT QUIT TERM HUP);
my $pid = fork();
die "fork: $!\n" unless defined $pid;
if ($pid == 0) {
  exec { $ARGV[0] } @ARGV or die "exec $ARGV[0]: $!\n";
}
my $r;
do { $r = waitpid($pid, 0) } while ($r == -1 && $!{EINTR});
my $st = $?;
open(my $fh, '>', "$out.tmp") or die "open: $!\n";
printf $fh '{"signal":%d,"core":%s,"code":%d}', $st & 127, ($st & 128) ? 'true' : 'false', $st >> 8;
close($fh);
rename("$out.tmp", $out) or die "rename: $!\n";
