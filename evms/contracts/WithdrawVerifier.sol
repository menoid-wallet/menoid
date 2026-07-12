// SPDX-License-Identifier: GPL-3.0
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity >=0.7.0 <0.9.0;

contract WithdrawVerifier {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 20491192805390485299153009773594534940189261866228447918068658471970481763042;
    uint256 constant alphay  = 9383485363053290200918347156157836566562967994039712273449902621266178545958;
    uint256 constant betax1  = 4252822878758300859123897981450591353533073413197771768651442665752259397132;
    uint256 constant betax2  = 6375614351688725206403948262868962793625744043794305715222011528459656738731;
    uint256 constant betay1  = 21847035105528745403288232691147584728191162732299865338377159692350059136679;
    uint256 constant betay2  = 10505242626370262277552901082094356697409835680220590971873171140371331206856;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 372272640448886992713303750862158355829166889823894665645089673686131033083;
    uint256 constant deltax2 = 20661863349692066232529181896321387876901770140289681304398358445785543742730;
    uint256 constant deltay1 = 17996431480852443989975039504670571729443215942117968244303182956069605698696;
    uint256 constant deltay2 = 12499224685640251286573142681424003278346812430780695740429119165662873549108;

    
    uint256 constant IC0x = 3289104466096070285972954361038213127200987179955577299090886143878595710553;
    uint256 constant IC0y = 11425649890128929207012674137348000501678552598634118164251188571275294336669;
    
    uint256 constant IC1x = 14278549682063552781963436622780246142329533222191229239253300944227557188233;
    uint256 constant IC1y = 13171198261545183911651761741999126752409459851164447288395333050499226460702;
    
    uint256 constant IC2x = 4228671074589984144168043897934855068921356857341266755224256248503817484324;
    uint256 constant IC2y = 20656127232434961774943255765964486535297354595275027182803146628169378108673;
    
    uint256 constant IC3x = 13590727271078154406258787711654126035917141456503457545355375167554715718600;
    uint256 constant IC3y = 9773208408212681823674104742335997949318231577619533430219886821540701202884;
    
    uint256 constant IC4x = 8559704435810426845327989731664730685107583429413897048410924023567330405336;
    uint256 constant IC4y = 12803156053891462815327686892452391310011075546909318499463979343290399482304;
    
    uint256 constant IC5x = 7418961855396368478844837489482325889818807648244430981118593496172780487746;
    uint256 constant IC5y = 5703549025508128956999495855223831769856018085002938075056484578232816687173;
    
    uint256 constant IC6x = 11204712664057113470754580026416926534749145166903864945894340928504506559258;
    uint256 constant IC6y = 15640380972740319375892769367017697308358560287456397367631487697430396656318;
    
    uint256 constant IC7x = 9136702389449504938244161488617353677033165386199823264488995248832500723087;
    uint256 constant IC7y = 5270326013693061075674517299864414248498248990375350048877034681166804296468;
    
    uint256 constant IC8x = 14229265188699599272355538198674823721909119976593149296776028287409982314088;
    uint256 constant IC8y = 15988870504781643808086405094044449302147963517952302602037774967992092359762;
    
    uint256 constant IC9x = 17415415851987103449607224607101391594337533512268356524222554646046403618746;
    uint256 constant IC9y = 12663571904665230309142261251828861392774450321453456651734807666233609502302;
    
    uint256 constant IC10x = 10351014685902806160319585301652024136269847160865641054130721492884584164402;
    uint256 constant IC10y = 4868766507700365040278742908701948054801733570741448443133988378556289982414;
    
    uint256 constant IC11x = 21223122818968810895378366065977447818732889632893317781197773402960055975135;
    uint256 constant IC11y = 13070876877900786821571943897295171818561859575440732930664479433890164307790;
    
    uint256 constant IC12x = 20876711106257240318455199125590488386038513286263269550326631778920996838474;
    uint256 constant IC12y = 18426655691355234273591410414923646729620632396648328149168775758877279360853;
    
    uint256 constant IC13x = 4912647164263812979915074391238753216416217531289042094603760059851787886155;
    uint256 constant IC13y = 14071563174782253558981726211427835717808632583604430427367315555161944978419;
    
    uint256 constant IC14x = 6973769307940438880442075921859549536231243018192259140842427559916224987542;
    uint256 constant IC14y = 9443016233661673522713705152326790587253842577238999374076905349516155079338;
    
    uint256 constant IC15x = 18984425530792400664252730866676111199548716509339209430054823293173670299453;
    uint256 constant IC15y = 7727472411418713873276723157323091707051232082361051149985739665288867558848;
    
    uint256 constant IC16x = 14858778054237330949754422665842297709345814299802851914500869680745065384479;
    uint256 constant IC16y = 6208594227029751415593876496095270869328879104130048917132443196268372332794;
    
    uint256 constant IC17x = 7006803307397533855762222078198634374086056663765226707242844251017397963235;
    uint256 constant IC17y = 7106449232844438657945995361520123407104007854456359912185670223159111967240;
    
    uint256 constant IC18x = 7833881129815984974461720628252278671971965655813280354287683151985862075029;
    uint256 constant IC18y = 11329499958892213569203491112507788059345800277821590686558856169238728623638;
    
    uint256 constant IC19x = 15572025986860650805806976917237406779004818319586751974259727865504526531629;
    uint256 constant IC19y = 6440062168865570149152764576946587119305855811101979877558151771570218341722;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[19] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }
            
            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x
                
                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))
                
                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))
                
                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))
                
                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))
                
                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))
                
                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))
                
                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))
                
                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))
                
                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))
                
                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))
                
                g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))
                
                g1_mulAccC(_pVk, IC12x, IC12y, calldataload(add(pubSignals, 352)))
                
                g1_mulAccC(_pVk, IC13x, IC13y, calldataload(add(pubSignals, 384)))
                
                g1_mulAccC(_pVk, IC14x, IC14y, calldataload(add(pubSignals, 416)))
                
                g1_mulAccC(_pVk, IC15x, IC15y, calldataload(add(pubSignals, 448)))
                
                g1_mulAccC(_pVk, IC16x, IC16y, calldataload(add(pubSignals, 480)))
                
                g1_mulAccC(_pVk, IC17x, IC17y, calldataload(add(pubSignals, 512)))
                
                g1_mulAccC(_pVk, IC18x, IC18y, calldataload(add(pubSignals, 544)))
                
                g1_mulAccC(_pVk, IC19x, IC19y, calldataload(add(pubSignals, 576)))
                

                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F
            
            checkField(calldataload(add(_pubSignals, 0)))
            
            checkField(calldataload(add(_pubSignals, 32)))
            
            checkField(calldataload(add(_pubSignals, 64)))
            
            checkField(calldataload(add(_pubSignals, 96)))
            
            checkField(calldataload(add(_pubSignals, 128)))
            
            checkField(calldataload(add(_pubSignals, 160)))
            
            checkField(calldataload(add(_pubSignals, 192)))
            
            checkField(calldataload(add(_pubSignals, 224)))
            
            checkField(calldataload(add(_pubSignals, 256)))
            
            checkField(calldataload(add(_pubSignals, 288)))
            
            checkField(calldataload(add(_pubSignals, 320)))
            
            checkField(calldataload(add(_pubSignals, 352)))
            
            checkField(calldataload(add(_pubSignals, 384)))
            
            checkField(calldataload(add(_pubSignals, 416)))
            
            checkField(calldataload(add(_pubSignals, 448)))
            
            checkField(calldataload(add(_pubSignals, 480)))
            
            checkField(calldataload(add(_pubSignals, 512)))
            
            checkField(calldataload(add(_pubSignals, 544)))
            
            checkField(calldataload(add(_pubSignals, 576)))
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
