-- uart_loader.vhd  (v2 — adds word_count output for LED debugging)
--
-- Receives 32-bit instruction words over JTAG UART, big-endian byte order,
-- and writes them into IMem through the processor's iInstLd port.
-- 0xDEADBEEF terminates loading and raises load_done.
--
-- Clocking contract (see wrapper): clk here MUST be the same physical clock
-- driving the processor's iCLK while loading, so the one-cycle mem_we pulse
-- is sampled exactly once by IMem.

library IEEE;
use IEEE.std_logic_1164.all;
use IEEE.numeric_std.all;

entity uart_loader is
    port (
        clk        : in  std_logic;
        rst        : in  std_logic;

        uart_byte  : in  std_logic_vector(7 downto 0);
        uart_valid : in  std_logic;

        mem_we     : out std_logic;
        mem_addr   : out std_logic_vector(31 downto 0);
        mem_data   : out std_logic_vector(31 downto 0);

        -- Number of words written so far (drives LEDR during loading)
        word_count : out std_logic_vector(9 downto 0);

        load_done  : out std_logic
    );
end entity uart_loader;

architecture behavioral of uart_loader is

    type state_t is (WAITING, BYTE1, BYTE2, BYTE3, WRITING, DONE);
    signal state : state_t := WAITING;

    signal word_buf  : std_logic_vector(31 downto 0) := (others => '0');
    signal word_addr : unsigned(9 downto 0) := (others => '0');

    constant END_SENTINEL : std_logic_vector(31 downto 0) := x"DEADBEEF";

begin

    word_count <= std_logic_vector(word_addr);

    process(clk)
    begin
        if rising_edge(clk) then
            mem_we <= '0';  -- default off

            if rst = '1' then
                state     <= WAITING;
                word_addr <= (others => '0');
                word_buf  <= (others => '0');
                mem_we    <= '0';
                load_done <= '0';

            else
                case state is

                    when WAITING =>
                        if uart_valid = '1' then
                            word_buf(31 downto 24) <= uart_byte;
                            state <= BYTE1;
                        end if;

                    when BYTE1 =>
                        if uart_valid = '1' then
                            word_buf(23 downto 16) <= uart_byte;
                            state <= BYTE2;
                        end if;

                    when BYTE2 =>
                        if uart_valid = '1' then
                            word_buf(15 downto 8) <= uart_byte;
                            state <= BYTE3;
                        end if;

                    when BYTE3 =>
                        if uart_valid = '1' then
                            word_buf(7 downto 0) <= uart_byte;
                            state <= WRITING;
                        end if;

                    when WRITING =>
                        if word_buf = END_SENTINEL then
                            state     <= DONE;
                            load_done <= '1';
                        else
                            mem_we    <= '1';
                            mem_addr  <= std_logic_vector(
                                         to_unsigned(16#00400000#, 32) +
                                         (word_addr & "00"));
                            mem_data  <= word_buf;
                            word_addr <= word_addr + 1;
                            state     <= WAITING;
                        end if;

                    when DONE =>
                        load_done <= '1';

                end case;
            end if;
        end if;
    end process;

end architecture behavioral;
